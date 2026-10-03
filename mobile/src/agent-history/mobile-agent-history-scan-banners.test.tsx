import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Text } from 'react-native'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../../src/shared/ai-vault-types'

vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value }
}))

import { MobileAgentHistoryScanBanners } from './mobile-agent-history-scan-banners'
import { styles } from './agent-history-styles'

let tree: ReactTestRenderer | undefined

afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})

function render(issues: AiVaultScanIssue[], sessions: { id: string }[] = []) {
  let mounted: ReactTestRenderer | undefined
  act(() => {
    mounted = create(<MobileAgentHistoryScanBanners sessions={sessions} issues={issues} />)
  })
  if (!mounted) {
    throw new Error('History banners did not mount')
  }
  tree = mounted
  return mounted.root.findAllByType(Text)
}

function sourceIssue(): AiVaultScanIssue {
  return {
    agent: 'opencode',
    kind: 'scope',
    executionHostId: 'ssh:dev-box',
    path: '/home/ada/.local/share/opencode/opencode.db',
    message: 'OpenCode history on dev-box is temporarily unavailable. Refresh to try again.'
  }
}

describe('mobile history scan banners', () => {
  it('shows source unavailability without claiming that a transcript was skipped', () => {
    const issue = sourceIssue()
    const texts = render([issue])

    expect(texts.map((node) => node.children.join(''))).toEqual([issue.message])
    expect(texts[0].props.style).toEqual(styles.noticeText)
  })

  it('counts only failed transcripts while retaining the source notice and actionable reason', () => {
    const issue = sourceIssue()
    const texts = render(
      [
        issue,
        { agent: 'claude', path: '/bad.jsonl', message: 'File too large: exceeds 10MB limit' },
        { agent: 'codex', kind: 'notice', path: '', message: 'Additional scan issues omitted.' }
      ],
      [{ id: 'session' }]
    )

    expect(texts.map((node) => node.children.join(''))).toEqual([
      issue.message,
      'Additional scan issues omitted.',
      '1 transcript skipped',
      'File too large: exceeds 10MB limit'
    ])
  })

  it('shows a blocking host error exactly once when there are no sessions', () => {
    const host: AiVaultScanIssue = {
      agent: 'codex',
      executionHostId: 'ssh:dev-box',
      kind: 'host',
      path: 'dev-box',
      message: 'dev-box disconnected. Reconnect the SSH target.'
    }
    const texts = render([host, sourceIssue()])

    expect(texts.map((node) => node.children.join(''))).toEqual([
      host.message,
      sourceIssue().message
    ])
    expect(texts[0].props.style).toEqual(styles.hostIssueText)
  })

  it('keeps distinct host notices visible alongside sessions', () => {
    const host: AiVaultScanIssue = {
      agent: 'codex',
      executionHostId: 'ssh:dev-box',
      kind: 'host',
      path: 'dev-box',
      message: 'dev-box disconnected.'
    }
    const texts = render(
      [host, { ...host, message: 'dev-box scan timed out.' }],
      [{ id: 'session' }]
    )

    expect(texts.map((node) => node.children.join(''))).toEqual([
      host.message,
      'dev-box scan timed out.'
    ])
    expect(texts.every((node) => node.props.style === styles.hostIssueText)).toBe(true)
  })

  it('renders no banner after a successful refresh', () => {
    expect(render([], [{ id: 'session' }])).toEqual([])
  })
})
