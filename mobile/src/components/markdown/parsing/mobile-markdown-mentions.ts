import { createContext, useMemo, useRef } from 'react'
import {
  scanSlackPeople,
  type SlackPeopleScan
} from '../../../../../src/shared/connectors/slack-mention-tokens'
import {
  SLACK_MENTION_HREF,
  type SlackPeople
} from '../../../../../src/shared/connectors/slack-message-markup'

/** The Slack people the chat knows; with them, Slack's `<@U…>` tokens in its text draw as names. */
export const MobileMarkdownSlackPeopleContext = createContext<SlackPeople | null>(null)

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

/** The Slack people a chat's messages name. Streaming hands a new array per delta: reads only what it added, and keeps the map while
 *  no one new appears. */
export function useMobileSlackPeople(
  messages: Parameters<typeof scanSlackPeople>[0]
): SlackPeople | null {
  const scan = useRef<SlackPeopleScan | null>(null)
  return useMemo(() => {
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    scan.current = scanSlackPeople(messages, scan.current)
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    return scan.current.people
  }, [messages])
}
