import { SLACK_MENTION_HREF } from '../../../../../src/shared/connectors/slack-message-markup'

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] }

function plainText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(plainText).join('') ?? ''
}

/** A Slack message's drawn form writes each mention as a link to the marker: drawn as a mention. */
export function drawMobileMarkdownSlackMentions(node: MarkdownNode): void {
  if (!node.children) {
    return
  }
  node.children = node.children.map((child) => {
    if (child.type === 'link' && child.url === SLACK_MENTION_HREF) {
      return { type: 'mention', value: plainText(child) }
    }
    drawMobileMarkdownSlackMentions(child)
    return child
  })
}
