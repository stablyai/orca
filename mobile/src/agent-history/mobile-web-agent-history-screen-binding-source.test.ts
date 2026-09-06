import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nativePanel = readFileSync(
  new URL('./MobileAgentSessionHistoryPanel.tsx', import.meta.url),
  'utf8'
)
const hostedRoute = readFileSync(
  new URL('../../host-web-app/h/[hostId]/agent-history/[worktreeId].tsx', import.meta.url),
  'utf8'
)
const presentation = readFileSync(
  new URL('./MobileAgentSessionHistoryPresentation.tsx', import.meta.url),
  'utf8'
)
const historyList = readFileSync(
  new URL('./MobileAgentSessionHistoryList.tsx', import.meta.url),
  'utf8'
)

describe('mobile web agent-history screen binding', () => {
  it('keeps native and hosted controllers on the same presentation source', () => {
    expect(nativePanel).toContain("from './MobileAgentSessionHistoryPresentation'")
    expect(hostedRoute).toContain("src/agent-history/MobileAgentSessionHistoryPresentation'")
    expect(presentation).toContain('<MobileAgentSessionHistoryList')
    expect(presentation).toContain('Agent Session History')
    expect(presentation).toContain('Search sessions, repo:, path:')
  })

  it('keeps host RPC and resume construction out of the hosted route', () => {
    for (const forbidden of [
      'useHostClient',
      'RpcClient',
      'aiVault.listSessions',
      'prepareMobileAiVaultSessionResume',
      'resumeAiVaultSessionInTerminal',
      'session.tabs.createTerminal',
      'terminal.send',
      'filePath',
      'codexHome',
      'executionHostId',
      'resumeCommand'
    ]) {
      expect(hostedRoute).not.toContain(forbidden)
    }
    expect(hostedRoute).toContain('shell.client.agentHistory')
  })

  it('preserves existing preview and malformed-session resume behavior', () => {
    expect(historyList).not.toContain('previewLoading')
    expect(historyList).not.toContain('card.resumeAvailable && onResume')
    expect(historyList).toContain('{onResume ? (')
    expect(hostedRoute).toContain('setResumeMessage(result.message)')
  })
})
