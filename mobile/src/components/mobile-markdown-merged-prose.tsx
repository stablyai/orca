import type { ComponentType, ReactNode } from 'react'
import type { StyleProp, TextProps, TextStyle } from 'react-native'
import type { MobileMarkdownBlock } from './mobile-markdown-parser'
import {
  markdownBlockGap,
  markdownListIndent,
  markdownListItemGap,
  styles
} from './mobile-markdown-styles'
import type { MobileSelectableParagraphComponent } from './mobile-selectable-paragraph'

type ListBlock = Extract<MobileMarkdownBlock, { type: 'list' }>
type ProseBlock = Extract<MobileMarkdownBlock, { type: 'paragraph' | 'heading' | 'list' }>

export type ProseBlockGroup = { kind: 'prose'; start: number; blocks: ProseBlock[] }
export type MarkdownBlockGroup =
  | ProseBlockGroup
  | { kind: 'block'; index: number; block: MobileMarkdownBlock }

function isProseBlock(block: MobileMarkdownBlock): block is ProseBlock {
  return block.type === 'paragraph' || block.type === 'heading' || block.type === 'list'
}

/** Runs of consecutive prose blocks become one group; every other block stands alone. */
export function groupProseBlocks(blocks: MobileMarkdownBlock[]): MarkdownBlockGroup[] {
  const groups: MarkdownBlockGroup[] = []
  blocks.forEach((block, index) => {
    const last = groups.at(-1)
    if (!isProseBlock(block)) {
      groups.push({ kind: 'block', index, block })
    } else if (last?.kind === 'prose') {
      last.blocks.push(block)
    } else {
      groups.push({ kind: 'prose', start: index, blocks: [block] })
    }
  })
  return groups
}

/** Renders each block, or each run of prose blocks as one group when `renderProse` is given. */
export function mapMarkdownBlocks(
  blocks: MobileMarkdownBlock[],
  renderProse: ((group: ProseBlockGroup) => ReactNode) | null,
  renderBlock: (block: MobileMarkdownBlock, index: number) => ReactNode
): ReactNode[] {
  if (!renderProse) {
    return blocks.map(renderBlock)
  }
  return groupProseBlocks(blocks).map((group) =>
    group.kind === 'prose' ? renderProse(group) : renderBlock(group.block, group.index)
  )
}

export function listMarker(block: ListBlock, itemIndex: number): string {
  const item = block.items[itemIndex]!
  if (item.checked != null) {
    return item.checked ? '[x]' : '[ ]'
  }
  return block.ordered ? `${itemIndex + 1}.` : '-'
}

type MergedProseInput = {
  blocks: ProseBlock[]
  Text: ComponentType<TextProps>
  Paragraph: MobileSelectableParagraphComponent
  renderInline: (text: string) => ReactNode[]
  proseStyle: StyleProp<TextStyle>
  listStyle: StyleProp<TextStyle>
}

/** One selectable text for a run of paragraphs, headings and lists: one native view, not one per block. */
export function MergedProse({
  blocks,
  Text,
  Paragraph,
  renderInline,
  proseStyle,
  listStyle
}: MergedProseInput): React.JSX.Element {
  return (
    <Text selectable style={proseStyle}>
      {blocks.map((block, blockIndex) => {
        const lastBlock = blockIndex === blocks.length - 1
        const blockSpacing = lastBlock ? 0 : markdownBlockGap
        const separator = lastBlock ? null : '\n'
        if (block.type === 'list') {
          return block.items.map((item, itemIndex) => {
            const lastItem = itemIndex === block.items.length - 1
            return (
              <Paragraph
                key={`${blockIndex}:${itemIndex}`}
                paragraph={{
                  headIndent: markdownListIndent,
                  spacing: lastItem ? blockSpacing : markdownListItemGap
                }}
                style={listStyle}
              >
                <Text style={styles.listMarkerRun}>{listMarker(block, itemIndex)}</Text>
                {'\t'}
                {renderInline(item.text)}
                {lastItem ? separator : '\n'}
              </Paragraph>
            )
          })
        }
        const style =
          block.type === 'heading'
            ? [styles.heading, block.level <= 2 ? styles.headingLarge : null]
            : undefined
        // Each soft-broken line is its own paragraph so copied text keeps plain newlines;
        // only the block's last line carries the gap to the next block.
        const lines = block.text.split('\n')
        return lines.map((line, lineIndex) => {
          const lastLine = lineIndex === lines.length - 1
          return (
            <Paragraph
              key={`${blockIndex}:${lineIndex}`}
              paragraph={{ spacing: lastLine ? blockSpacing : 0 }}
              style={style}
            >
              {renderInline(line)}
              {lastLine ? separator : '\n'}
            </Paragraph>
          )
        })
      })}
    </Text>
  )
}
