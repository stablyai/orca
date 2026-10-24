import { COLOR, CALLOUT, ALERT, TASK, BAR, FRAME, forms, bar } from './theme'
import type { Register, RenderElement } from 'claude-code'
import { inline, hasStrike } from './inline'
import type { Inline } from './inline'
import { SWITCHES, FENCE, FORMULA, fit, parse, plain } from './blocks'
import type { Block, Switch } from './blocks'

// A Button's key, from what it copies: a reply is drawn in parts when two mods
// draw it between them, so a count kept by one part would repeat in the next.
const hash = (text: string) =>
  (
    [...text].reduce((sum, char) => (Math.imul(sum, 31) + char.charCodeAt(0)) | 0, 0) >>> 0
  ).toString(36)

/** The switch a block is drawn under; undefined for raw text. */
function switchOf(block: Block): Switch | undefined {
  switch (block.kind) {
    case 'heading':
      return 'headings'
    case 'item':
      return 'lists'
    case 'quote':
      return ALERT.test(block.text) ? 'callouts' : 'quotes'
    case 'table':
      return 'tables'
    case 'rule':
      return 'rules'
    case 'code':
      return 'codeCards'
    default:
      return undefined
  }
}

/** A block as markdown again, near enough to what was written for the engine to draw it. */
function markdownOf(block: Block): string {
  switch (block.kind) {
    case 'raw':
      return block.text
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`
    case 'item': {
      const indent = ' '.repeat(block.depth * 2)

      return block.text
        .split('\n')
        .map((line, index) =>
          index === 0 ? `${indent}${block.marker} ${line}` : `${indent}  ${line}`
        )
        .join('\n')
    }
    case 'quote':
      return block.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    case 'table':
      return block.source
    case 'rule':
      return '---'
    case 'code': {
      // Longer than any run of backticks inside, so that the fence holds.
      const ticks = '`'.repeat(
        Math.max(3, ...(block.source.match(/`+/g) ?? []).map((run) => run.length + 1))
      )

      return `${ticks}${block.language}\n${block.source}\n${ticks}`
    }
  }
}

/** The blocks with each one switched off made raw text again, joined to the raw text beside it. */
function restyle(blocks: Block[], off: ReadonlySet<Switch>) {
  const kept: Block[] = []
  for (const block of blocks) {
    const name = switchOf(block)
    const each: Block =
      name !== undefined && off.has(name)
        ? { kind: 'raw', text: markdownOf(block), hasGapAbove: block.hasGapAbove }
        : block
    const last = kept.at(-1)
    if (each.kind === 'raw' && last?.kind === 'raw') {
      last.text += (each.hasGapAbove ? '\n\n' : '\n') + each.text
    } else {
      kept.push(each)
    }
  }

  return kept
}

// CommonMark closes a `**` only where punctuation inside it does not meet a
// letter outside, and Chinese sets no space after its stops: `**收斂。**記憶`
// is drawn as written. Moving the punctuation out (`**收斂**。記憶`) draws it
// bold. A code span is matched first and kept whole, inside bold or not.
// ponytail: one line at a time, single-backtick code spans inside bold; a
// bold run across a line break, and `***bold italic***`, are left as written.
const BOLD =
  /(`+)[^`\n]*?\1(?!`)|\*\*((?:(?!\*)\p{P})*)((?:`[^`\n]*`|[^*`\n])*?)((?:(?!\*)\p{P})*)\*\*/gu
const ENDS_IN_LETTER = /[^\s\p{P}\p{S}]$/u
const STARTS_WITH_LETTER = /^[^\s\p{P}\p{S}]/u

/** The text with each bold run closable, its fences and `$$` formulas left as written. */
function holdBold(text: string) {
  let fence: string | undefined

  return text
    .split('\n')
    .map((line) => {
      const run = FENCE.exec(line)?.[1] ?? (FORMULA.test(line) ? '$$' : undefined)
      if (fence !== undefined) {
        if (
          run !== undefined &&
          run[0] === fence[0] &&
          run.length >= fence.length &&
          line.trim() === run
        ) {
          fence = undefined
        }

        return line
      }
      fence = run

      return run !== undefined
        ? line
        : line.replace(BOLD, (whole, ticks?: string, lead = '', body = '', trail = '', at = 0) => {
            const isStuck =
              (lead !== '' && ENDS_IN_LETTER.test(line.slice(0, at))) ||
              (trail !== '' && STARTS_WITH_LETTER.test(line.slice(at + whole.length)))

            return ticks !== undefined || !isStuck || body === '' || body.trim() !== body
              ? whole
              : `${lead}**${body}**${trail}`
          })
    })
    .join('\n')
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  // A style the settings do not hold, or one the mod does not draw, is the
  // default: for a table, no frame (`rules`).
  const frame = FRAME[String(options.tableBorder)]
  const cardBorder = String(options.cardBorder) in FRAME ? String(options.cardBorder) : 'round'
  const off = new Set(SWITCHES.filter((name) => options[name] === false))
  const told = forms(off)

  // Told only where a terminal draws the reply: under `-p`, the SDK or an app
  // the forms would not be drawn.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isDrawn = e.surfaces.includes('terminal')

    return isDrawn && told !== undefined
      ? {
          sections: [
            ...composed.sections,
            { id: 'reply-markdown:forms', text: told, scope: 'session' }
          ]
        }
      : composed
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary) {
      return next(e)
    }

    const text = holdBold(e.props.text)
    const blocks = restyle(parse(text), off)

    if (blocks.every((block) => block.kind === 'raw' && !hasStrike(inline(block.text)))) {
      return next({ ...e, props: { ...e.props, text } })
    }

    const { Box, Button, Code, Link, Markdown, Text } = $.ui.resolve(e)
    const spans = (parts: Inline[]): (string | RenderElement)[] => {
      const occurrences = new Map<string, number>()
      return parts.map((part) => {
        if ('text' in part) {
          return part.text
        }
        const content = JSON.stringify(part)
        const count = occurrences.get(content) ?? 0
        occurrences.set(content, count + 1)
        const key = `${content}:${count}`
        if ('code' in part) {
          return (
            <Text key={key} color={COLOR.h1}>
              {part.code}
            </Text>
          )
        }
        if (part.mark === 'link') {
          return (
            <Link key={key} href={part.href!}>
              {spans(part.children)}
            </Link>
          )
        }
        const style = part.mark === 'strike' ? { strikethrough: true } : { [part.mark]: true }
        return (
          <Text key={key} {...style}>
            {spans(part.children)}
          </Text>
        )
      })
    }
    const prose = (text: string, dimColor = false) => {
      const parts = inline(text)
      return hasStrike(parts) ? (
        <Text dimColor={dimColor}>{spans(parts)}</Text>
      ) : (
        <Markdown text={text} dimColor={dimColor} />
      )
    }
    // The engine wraps its own prose at the `maxProseWidth` setting; the mod's
    // blocks keep to the same width.
    const { maxProseWidth } = await $.settings.read()
    const room = Math.max(10, (e.viewport?.columns ?? 80) - 6)
    const columns = typeof maxProseWidth === 'number' ? Math.min(room, maxProseWidth) : room
    const rows: RenderElement[] = []

    for (const [index, block] of blocks.entries()) {
      const isSpaced = block.hasGapAbove || block.kind === 'heading'
      const marginTop = index > 0 && isSpaced ? 1 : 0

      // The engine draws what the mod does not restyle, without its bullet
      // and under a blank row of its own.
      const unstyled = (text: string) =>
        next({ ...e, props: { ...e.props, text, isFirstOfReply: false } })

      if (block.kind === 'raw') {
        rows.push(
          hasStrike(inline(block.text)) ? (
            <Box marginTop={1} width={columns}>
              {prose(block.text)}
            </Box>
          ) : (
            await unstyled(block.text)
          )
        )
      } else if (block.kind === 'code') {
        const { source } = block
        rows.push(
          <Box
            flexDirection="column"
            marginTop={marginTop}
            paddingX={1}
            width={columns}
            borderStyle={cardBorder}
            borderColor={COLOR.rule}
          >
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{block.language || 'text'}</Text>
              <Button
                key={`copy:${hash(source)}`}
                label="copy"
                plain
                dimColor
                onPress={async (press) => {
                  const copied = await $.ui.copy({ text: source, surface: press.surface })
                  $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
                }}
              />
            </Box>
            <Code source={source} language={block.language || undefined} />
          </Box>
        )
      } else if (block.kind === 'table') {
        const widths = fit(block, columns)
        if (widths === undefined) {
          rows.push(await unstyled(block.source))
          continue
        }

        // The frame is drawn as text, so that its lines meet in the right
        // glyphs; a bar spans its row's height however the cells wrap.
        const upright = frame && bar(frame.bar)
        const rule = (text: string, color: string) => (
          <Text color={color} wrap="truncate-end">
            {text}
          </Text>
        )
        const edge = ([left = '', cross = '', right = '']: string, line: string) =>
          rule(left + widths.map((each) => line.repeat(each + 2)).join(cross) + right, COLOR.rule)
        const offsets = widths.map((_, column) =>
          widths.slice(0, column).reduce((sum, each) => sum + each + 3, 0)
        )
        const total = widths.reduce((sum, each) => sum + each + 3, 1)
        const row = (texts: string[], isHeader: boolean) => (
          <Box flexDirection="row" width={total}>
            {upright &&
              [...offsets, total - 1].map((left) => (
                <Box
                  key={left}
                  position="absolute"
                  top={0}
                  bottom={0}
                  left={left}
                  width={1}
                  overflow="hidden"
                >
                  <Text color={COLOR.rule}>{upright}</Text>
                </Box>
              ))}
            {widths.map((each, column) => (
              <Box
                key={column}
                flexDirection="column"
                alignItems={block.align[column]}
                width={each + 3}
                paddingLeft={2}
                paddingRight={1}
              >
                {isHeader ? (
                  <Text bold color={COLOR.h3}>
                    {plain(texts[column] ?? '')}
                  </Text>
                ) : (
                  prose(texts[column] ?? '')
                )}
              </Box>
            ))}
          </Box>
        )
        const body = block.rows.map((texts) => row(texts, false))
        rows.push(
          <Box flexDirection="column" marginTop={marginTop}>
            {frame
              ? [
                  edge(frame.edges[0], frame.line),
                  row(block.header, true),
                  edge(frame.edges[1], frame.line),
                  ...body,
                  edge(frame.edges[2], frame.line)
                ]
              : [
                  row(block.header, true),
                  rule('━'.repeat(total), COLOR.headRule),
                  ...body.flatMap((each, index) =>
                    index === 0 ? [each] : [rule('─'.repeat(total), COLOR.rowRule), each]
                  )
                ]}
          </Box>
        )
      } else if (block.kind === 'rule') {
        rows.push(
          <Box marginTop={marginTop}>
            <Text color={COLOR.rule} wrap="truncate-end">
              {'─'.repeat(columns)}
            </Text>
          </Box>
        )
      } else if (block.kind === 'heading') {
        const title = block.text.replace(/\*\*|`/g, '')
        const color = [COLOR.h2, COLOR.h3, COLOR.h4][Math.min(block.level, 4) - 2]
        rows.push(
          <Box marginTop={marginTop}>
            {block.level === 1 ? (
              <Text bold color={COLOR.ink} backgroundColor={COLOR.h1}>
                {` ${title} `}
              </Text>
            ) : (
              <Text bold color={color}>
                {block.level === 2 ? '▌ ' : ''}
                {title}
              </Text>
            )}
          </Box>
        )
      } else if (block.kind === 'quote' && ALERT.test(block.text)) {
        const [marker = '', name = ''] = ALERT.exec(block.text) ?? []
        const { label = name, color } = CALLOUT[name.toUpperCase()] ?? {}
        const body = block.text.slice(marker.length)
        rows.push(
          <Box
            flexDirection="column"
            marginTop={marginTop}
            paddingX={1}
            width={columns}
            borderStyle={cardBorder}
            borderColor={color}
          >
            <Text bold color={color}>
              {label}
            </Text>
            {body.trim() !== '' && prose(body)}
          </Box>
        )
      } else if (block.kind === 'quote') {
        // The bar spans the quote's rows however its text wraps.
        rows.push(
          <Box marginTop={marginTop} paddingLeft={2} width={columns}>
            <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden">
              <Text color={COLOR.quote}>{BAR}</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {prose(block.text, true)}
            </Box>
          </Box>
        )
      } else {
        const isOrdered = /\d/.test(block.marker)
        const bullet = block.depth === 0 ? '•' : '◦'
        // A task: `- [ ] todo`, `- [x] done`.
        const [, state, todo] = TASK.exec(block.text) ?? []
        const isDone = state !== undefined && state !== ' '
        rows.push(
          <Box
            flexDirection="row"
            marginTop={marginTop}
            paddingLeft={block.depth * 2}
            width={columns}
          >
            {state === undefined ? (
              <Text color={isOrdered ? COLOR.number : COLOR.bullet}>
                {isOrdered ? block.marker : bullet}{' '}
              </Text>
            ) : (
              <Text color={isDone ? COLOR.bullet : COLOR.rule}>{isDone ? '☑ ' : '☐ '}</Text>
            )}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              {prose(todo ?? block.text)}
            </Box>
          </Box>
        )
      }
    }

    // A reply sits one row under what precedes it: the engine's own text
    // brings that row, a block of the mod's needs it given.
    const hasOwnRowAbove = blocks[0]?.kind === 'raw'

    return (
      <Box flexDirection="row" marginTop={hasOwnRowAbove ? 0 : 1}>
        {e.props.isFirstOfReply && (
          <Box marginTop={hasOwnRowAbove ? 1 : 0}>
            <Text color="text">⏺ </Text>
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {rows}
        </Box>
      </Box>
    )
  })
}
