import { isGone, imageSource, cachedFrames, cacheVideoFrames } from './render-process'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Diagram, Frames } from '../types'
import { KINDS, forms, hash, splitBlocks, classify } from './blocks'
import { render, renderResumed, scheduleRender } from './diagrams'

// Atom addresses must be file-local for the hook scanner; the renderer uses the same key.
const diagrams = atom({ plugin: 'reply-media', key: 'diagrams' } as const, {})
const zoomed = atom({ plugin: 'reply-media', key: 'zoomed' } as const, null)
const playing = atom({ plugin: 'reply-media', key: 'playing' } as const, null)
const preparing = atom({ plugin: 'reply-media', key: 'preparing' } as const, null)
const PANE = 'picture-zoom'
// A swept preview gets one redraw and one recovery attempt, never a retry on every draw.
const redrawn = new Map<string, 'attempted' | 'retryable'>()
// One video plays at a time. Where each one stopped is kept by its block; the
// drawing reads it when the `playing` value changes.
// shortcut: kept in the module, so a reload of the mod rewinds every video;
// keep it in `$.state` if that starts to matter.
type PlaybackTimer = { cancel: () => void }
let timer: PlaybackTimer | undefined
let playRequest = 0
const stoppedAt = new Map<string, number>()

const frameFile = (frames: Frames, index: number) =>
  `${frames.dir}/f${String(index + 1).padStart(5, '0')}.png`

/** Stops the video that is playing, if one is. */
async function stop($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  await update($, playing, () => null)
}

/**
 * Plays the video of `block` in the Image `key` of the row `site`, from where
 * it stopped, or stops it when it is the one playing.
 */
async function toggle($: EngineInterface, site: string, key: string, block: string) {
  const request = ++playRequest
  const wasPlaying = (await read($, playing)) === block
  const wasPreparing = (await read($, preparing)) === block
  await stop($)
  await update($, preparing, () => null)
  const diagram = (await read($, diagrams))[block]
  if (wasPlaying || wasPreparing || !diagram || 'error' in diagram || !diagram.clip) {
    return
  }

  // Keep a button dispatch short. First-time extraction can take much longer
  // than a UI press; a host-owned timer survives its return and is cancelled
  // automatically when the plugin reloads. A second press cancels the intent,
  // and a completed older extraction must never take over another video.
  await update($, preparing, () => block)
  $.clock.after(0, async () => {
    try {
      await startVideo($, site, key, block, diagram, request)
    } catch (error) {
      if (request === playRequest) {
        $.ui.toast(`Not played: ${String(error)}`)
      }
    } finally {
      if (request === playRequest) {
        await update($, preparing, () => null)
      }
    }
  })
}

async function startVideo(
  $: EngineInterface,
  site: string,
  key: string,
  block: string,
  diagram: Diagram,
  request: number
) {
  if (request !== playRequest || !diagram.clip) {
    return
  }

  // Cut at the first play, not when the reply arrives: it takes seconds and
  // disk, and most clips shown are never played.
  const known = await cachedFrames($, diagram.frames)
  if (request !== playRequest) {
    return
  }
  if (known === undefined) {
    $.ui.toast('Cutting the video into frames…')
  }
  const frames = known ?? (await cacheVideoFrames($, diagram.clip))
  if (request !== playRequest) {
    return
  }
  if ('error' in frames) {
    $.ui.toast(`Not played: ${frames.error}`)

    return
  }
  if (frames !== diagram.frames) {
    await update($, diagrams, (all) => ({ ...all, [block]: { ...diagram, frames } }))
  }

  // From the start again once it has reached its end.
  const from = stoppedAt.get(block) ?? 0
  let index = from >= frames.count - 1 ? 0 : from
  await update($, playing, (current) => (request === playRequest ? block : current))
  await update($, preparing, (current) => (request === playRequest ? null : current))
  if (request !== playRequest) {
    return
  }
  // A second press while the cut ran started a timer of its own.
  timer?.cancel()
  const own: PlaybackTimer = $.clock.every(Math.round(1000 / frames.fps), async () => {
    const shown = index++
    const isLast = shown >= frames.count - 1
    if (isLast) {
      own.cancel()
    }
    stoppedAt.set(block, shown)
    try {
      const source = await imageSource($, frameFile(frames, shown))
      const blit = await $.ui.blit({ requestId: site, key, source })
      // Denied when no Image is mounted to swap: the row scrolled away.
      if (timer === own && (isLast || blit.deny !== undefined)) {
        await stop($)
      }
    } catch {
      if (timer === own) {
        await stop($)
      }
    }
  })
  timer = own
}

export const register: Register = (on, options) => {
  if (options.enabled === false) {
    return
  }

  // ponytail: a cell's height over its width and the picture pixels a column
  // shows are the person's to tune (`/config`): they depend on the terminal
  // and its font, which the mod cannot measure.
  const cellAspect = Number(options.cellAspect)
  const pxPerColumn = Number(options.pxPerColumn)
  const resumedReplies = Number(options.resumedReplies)
  const drawn = new Set(
    KINDS.filter(([option]) => options[option] !== false).map(([, script]) => script)
  )
  const told = forms(drawn)
  // Under a picture: copy its source, and zoom it (a video: open it in the player).
  const hasButtons = options.buttons !== false

  // Told only where a terminal draws the reply: under `-p`, the SDK or an app
  // the forms would come out as their source.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const isDrawn = e.surfaces.includes('terminal')

    return isDrawn && told !== undefined
      ? {
          sections: [
            ...composed.sections,
            { id: 'reply-media:forms', text: told, scope: 'session' }
          ]
        }
      : composed
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const appended = await next(e)
    const content = appended.message?.content
    if (
      !content?.some(
        (block) => typeof block.text === 'string' && splitBlocks(block.text).length > 1
      )
    ) {
      return appended
    }

    // Keep optional converters off the transcript/model critical path. The host
    // owns this timer and cancels it when the plugin reloads.
    $.clock.after(0, async () => {
      try {
        if (!(await $.session.surfaces()).includes('terminal')) {
          return
        }
        for (const block of content) {
          if (typeof block.text === 'string') {
            await render($, block.text, drawn)
          }
        }
      } catch (error) {
        $.ui.toast(`Media preview failed: ${String(error)}`)
      }
    })

    return appended
  })

  // The replies a resumed session opens with were appended by an earlier
  // process, so their blocks are rendered here. A new session has none.
  on('session.start', async ($, e, next) => {
    // A reload starts the module over with no timer, but the value is kept.
    try {
      await stop($)
      const replies = (await $.session.messages()).filter(
        (message) => message.role === 'assistant' && message.text !== ''
      )

      // `slice(-0)` would keep every reply. A session no terminal draws gets none.
      const count = e.surface === 'terminal' ? resumedReplies : 0
      await renderResumed(
        $,
        count > 0 ? replies.slice(-count).map((reply) => reply.text) : [],
        drawn
      )
    } catch (error) {
      $.ui.toast(`Media preview failed: ${String(error)}`)
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') {
      return next(e)
    }
    const blocks = splitBlocks(e.props.text)
    if (blocks.length === 1) {
      return next(e)
    }

    const known = await read($, diagrams)
    const pieces: (
      | string
      | { block: string; alt: string; isFile: boolean; diagram: Diagram }
      | { block: string; alt: string; error: string }
    )[] = []
    let text = ''
    for (const [index, part] of blocks.entries()) {
      // A kind switched off keeps its block as text, drawn before or not.
      let outcome = index % 2 === 1 && classify(part, drawn) !== undefined ? known[part] : undefined
      // The temp folder is swept after some days. The block is text again
      // while its picture is drawn again from it.
      if (outcome && !('error' in outcome) && (await isGone($, outcome.file))) {
        outcome = undefined
        const redraw = redrawn.get(part)
        if (redraw !== 'attempted') {
          redrawn.set(part, 'attempted')
          scheduleRender($, part, drawn, true, () => {
            redrawn.set(part, redraw === undefined ? 'retryable' : 'attempted')
          })
        }
      }

      if (outcome) {
        const job = classify(part, drawn)
        const alt = job?.source ?? part
        const isFile = job?.script === 'picture' || job?.script === 'video'
        pieces.push(
          text,
          'error' in outcome
            ? { block: part, alt, error: outcome.error }
            : { block: part, alt, isFile, diagram: outcome }
        )
        text = ''
      } else {
        // A block with no outcome (one the mod does not draw, one not
        // rendered yet) stays as it was written.
        text += part
      }
    }

    if (pieces.length === 0) {
      return next(e)
    }

    const { Box, Button, Image, Link, Text } = $.ui.resolve(e)
    const room = Math.max(1, (e.viewport?.columns ?? 80) - 4)
    // The engine draws the reply's bullet with the text that opens it; a
    // reply that opens with a picture gets its bullet here, beside it.
    const [opening = ''] = pieces
    const hasOwnBullet =
      e.props.isFirstOfReply && typeof opening === 'string' && opening.trim() === ''
    // The engine indents nothing but the block its bullet opens, so what
    // follows that block lines up under its text here.
    const indent = e.props.isFirstOfReply && !hasOwnBullet ? 2 : 0
    const children: RenderElement[] = []

    for (const piece of [...pieces, text]) {
      if (typeof piece === 'string') {
        if (piece.trim() !== '') {
          // The engine draws the text around a picture, bullet and all.
          const isFirst = children.length === 0
          const drawn = await next({
            ...e,
            props: {
              ...e.props,
              text: piece.trim(),
              isFirstOfReply: e.props.isFirstOfReply && isFirst
            }
          })
          children.push(isFirst ? drawn : <Box paddingLeft={indent}>{drawn}</Box>)
        }

        continue
      }

      if ('error' in piece) {
        // Boxed in the error color, so that a block which failed is not taken
        // for plain text: the reason, then what the script was given.
        children.push(
          <Box flexDirection="column" paddingLeft={indent} marginTop={1}>
            <Box
              flexDirection="column"
              alignSelf="flex-start"
              paddingX={1}
              borderStyle="round"
              borderColor="error"
            >
              <Text bold color="error">{`✗ not drawn: ${piece.error}`}</Text>
              <Text dimColor>{piece.alt}</Text>
              <Button
                key={`retry:${hash(piece.block)}`}
                label="retry"
                onPress={() => {
                  scheduleRender($, piece.block, drawn, true)
                }}
              />
            </Box>
          </Box>
        )

        continue
      }

      const { file, width, height, path, clip, frames } = piece.diagram
      const widest = Math.min(room, 255)
      const natural = Math.min(widest, Math.ceil(width / pxPerColumn))
      // Whole rows first, then the columns that keep the picture's shape: a
      // formula one row tall is drawn a little larger, not stretched.
      const rows = Math.min(255, Math.max(1, Math.round((natural * height) / width / cellAspect)))
      const columns = Math.min(
        widest,
        Math.max(1, Math.round((rows * cellAspect * width) / height))
      )
      const { block, alt } = piece
      const key = hash(block)
      const site = e.requestId
      const isPlaying = clip !== undefined && (await read($, playing)) === block
      const isPreparing = clip !== undefined && (await read($, preparing)) === block
      const current = frames === undefined ? file : frameFile(frames, stoppedAt.get(block) ?? 0)
      const source = await imageSource($, current).catch(() =>
        current === file ? undefined : imageSource($, file).catch(() => undefined)
      )
      if (!source) {
        const props = {
          ...e.props,
          text: block,
          isFirstOfReply: e.props.isFirstOfReply && children.length === 0
        }
        children.push(await next({ ...e, props }))
        continue
      }
      redrawn.delete(block)
      children.push(
        <Box flexDirection="column" paddingLeft={indent} marginTop={1}>
          <Image
            // Keyed for a video alone: its frames are swapped in under that key.
            key={clip === undefined ? undefined : `view:${key}`}
            // It shows the frame it stopped at, so a redraw does not rewind
            // it; before its first play, its first frame.
            source={source}
            columns={columns}
            rows={rows}
            alt={alt}
          />
          <Box flexDirection="row" gap={2}>
            {clip !== undefined && (
              <Button
                key={`play:${key}`}
                label={isPreparing ? 'cancel loading' : isPlaying ? '❚❚ pause' : '▶ play'}
                plain
                onPress={() => toggle($, site, `view:${key}`, block)}
              />
            )}
            {hasButtons && (
              <Button
                key={`copy:${key}`}
                label={piece.isFile ? 'copy path' : 'copy source'}
                plain
                dimColor
                onPress={async (press) => {
                  // A file by the absolute path its script opened, not as written.
                  const text = piece.isFile ? (path ?? clip ?? alt) : alt
                  const copied = await $.ui.copy({ text, surface: press.surface })
                  $.ui.toast(copied.isCopied ? 'Copied' : `Not copied: ${copied.reason}`)
                }}
              />
            )}
            {!hasButtons ? undefined : clip === undefined ? (
              <Button
                key={`zoom:${key}`}
                label="zoom"
                plain
                dimColor
                onPress={async () => {
                  await update($, zoomed, () => block)
                  // Asked for by this press, so it is placed at any width: docked
                  // beside the transcript from 110 columns, above the prompt below.
                  await $.ui.open({
                    id: PANE,
                    title: 'Picture',
                    closeOnEscape: true,
                    columns: Math.round((e.viewport?.columns ?? 80) * 0.6),
                    rows: Math.round((e.viewport?.rows ?? 24) * 0.6)
                  })
                }}
              />
            ) : (
              // Let the terminal route the file on its execution host. Running
              // macOS `open` on a remote Linux host cannot open a laptop player.
              <Link href={clip} label="open file" />
            )}
          </Box>
        </Box>
      )
    }

    return hasOwnBullet ? (
      // Level with the picture, which brings a blank row above itself.
      <Box flexDirection="row">
        <Box marginTop={1}>
          <Text color="text">⏺ </Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {children}
        </Box>
      </Box>
    ) : (
      // No gap: the engine's text brings a blank row above itself.
      <Box flexDirection="column">{children}</Box>
    )
  })

  // The zoomed picture, as large as the pane's body holds with its shape kept.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const block = await read($, zoomed)
    const diagram = block === null ? undefined : (await read($, diagrams))[block]
    const source =
      e.surface !== 'terminal' || block === null || !diagram || 'error' in diagram
        ? undefined
        : await imageSource($, diagram.file).catch(() => undefined)
    if (e.surface !== 'terminal' || !source || block === null || !diagram || 'error' in diagram) {
      return <Text dimColor>No picture to show.</Text>
    }

    const { Box, Image } = $.ui.resolve(e)

    const wide = Math.min(255, Math.max(1, e.props.bodyColumns))
    const tall = Math.min(255, Math.max(1, e.props.scroll.bodyRows))
    const rows = Math.round((wide * diagram.height) / diagram.width / cellAspect)
    const isTooTall = rows > tall
    const columns = isTooTall
      ? Math.round((tall * cellAspect * diagram.width) / diagram.height)
      : wide

    return (
      <Box>
        <Image
          source={source}
          columns={Math.max(1, columns)}
          rows={Math.max(1, isTooTall ? tall : rows)}
          alt={classify(block, drawn)?.source ?? block}
        />
      </Box>
    )
  })
}
