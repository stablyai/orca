import { createElement, type ContextType, type PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { MobileNativeChatNoticeRow, MobileHeldTerminalContext } from './MobileNativeChatNoticeRow'
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Text: ({ children }: PropsWithChildren) => createElement('span', null, children),
  View: ({ children }: PropsWithChildren) => createElement('div', null, children),
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  Info: 'Info'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
const leafId = '11111111-1111-4111-8111-111111111111'
const heldScreen = {
  worktreeId: 'w',
  agent: 'codex',
  tabs: [
    {
      type: 'terminal',
      id: 'pane',
      parentTabId: 't',
      leafId,
      title: 'Review',
      terminal: 'pty',
      incarnationId: 'life',
      isActive: false
    }
  ]
} satisfies NonNullable<ContextType<typeof MobileHeldTerminalContext>>
const missingScreen = { ...heldScreen, tabs: [] }
it.each(['named', 'workspace', 'missing', 'replaced', 'legacy'] as const)(
  'renders a plain title only for the matching screen: %s',
  (kind) => {
    const text = renderToStaticMarkup(
      <MobileHeldTerminalContext.Provider value={kind === 'missing' ? missingScreen : heldScreen}>
        <MobileNativeChatNoticeRow
          fontScale={1}
          blocks={[
            {
              type: 'text',
              tone: 'error',
              text: 'Unnamed fallback',
              failure: { kind: 'conversationOpenInTerminal' },
              heldByTerminal: {
                paneKey: `t:${leafId}`,
                worktreeId: kind === 'workspace' ? 'other' : 'w',
                incarnationId: kind === 'legacy' ? undefined : kind === 'replaced' ? 'old' : 'life'
              }
            }
          ]}
        />
      </MobileHeldTerminalContext.Provider>
    )
    expect(text).toContain(
      kind === 'named'
        ? 'Codex may still be running this conversation in Review.'
        : 'Unnamed fallback'
    )
    expect(text).not.toMatch(/<(a|button)\b/)
  }
)
