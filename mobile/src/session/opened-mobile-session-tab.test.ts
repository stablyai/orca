import { describe, expect, it } from 'vitest'
import {
  activateOpenedMobileSessionTab,
  activateOpenedSourceControlDiffTab,
  findOpenedMobileSessionTab,
  refreshOpenedMobileSessionTabs,
  shouldActivateOpenedMobileSessionTab,
  type OpenedMobileSessionTabCandidate
} from './opened-mobile-session-tab'

describe('findOpenedMobileSessionTab', () => {
  it('matches a file tab by relative path', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'terminal', id: 'term' },
      { type: 'file', id: 'file-1', relativePath: 'src/app.ts' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'src/app.ts')?.id).toBe('file-1')
  })

  it('matches a markdown tab by relative path', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'file', id: 'file-1', relativePath: 'src/app.ts' },
      { type: 'markdown', id: 'md-1', relativePath: 'README.md' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'README.md')?.id).toBe('md-1')
  })

  it('ignores non-openable tabs even if they carry path-shaped data', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'browser', id: 'browser-1', relativePath: 'README.md' },
      { type: 'terminal', id: 'term-1', relativePath: 'README.md' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'README.md')).toBeNull()
  })

  it('matches future file-like tab types that carry a relative path', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'image', id: 'image-1', relativePath: 'assets/logo.png' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'assets/logo.png')?.id).toBe('image-1')
  })

  it('matches a diff tab opened from mobile source control', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'terminal', id: 'term' },
      { type: 'file', id: 'diff-1', mode: 'diff', relativePath: 'src/app.ts' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'src/app.ts')?.id).toBe('diff-1')
  })

  it('skips diff tabs when an edit tab has the same relative path', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'file', id: 'diff-1', mode: 'diff', relativePath: 'src/app.ts' },
      { type: 'file', id: 'edit-1', mode: 'edit', relativePath: 'src/app.ts' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'src/app.ts')?.id).toBe('edit-1')
  })

  it('can prefer a diff tab when source control just opened one', () => {
    const tabs: OpenedMobileSessionTabCandidate[] = [
      { type: 'markdown', id: 'edit-1', relativePath: 'README.md' },
      { type: 'file', id: 'diff-1', mode: 'diff', relativePath: 'README.md' }
    ]

    expect(findOpenedMobileSessionTab(tabs, 'README.md', { preferMode: 'diff' })?.id).toBe('diff-1')
  })
})

describe('refreshOpenedMobileSessionTabs', () => {
  it('waits for a current refresh before requesting a post-open snapshot', async () => {
    const order: string[] = []
    let resolveCurrentRefresh: () => void = () => {}
    const currentRefresh = new Promise<void>((resolve) => {
      resolveCurrentRefresh = resolve
    })

    const refresh = refreshOpenedMobileSessionTabs({
      getCurrentRefresh: () => currentRefresh,
      refreshSessionTabs: async () => {
        order.push('fresh')
      }
    })

    await Promise.resolve()
    expect(order).toEqual([])

    order.push('current')
    resolveCurrentRefresh()
    await refresh

    expect(order).toEqual(['current', 'fresh'])
  })
})

describe('activateOpenedMobileSessionTab', () => {
  const fileTab = { type: 'file', id: 'file-1', relativePath: 'src/app.ts' }

  function createActivationHarness() {
    let tabs: OpenedMobileSessionTabCandidate[] = []
    let activeTabId: string | null = 'terminal-1'
    let activated = false
    const activationSeq = 1
    let latestActivationSeq = 1
    let activeTerminalHandle: string | null = 'pty-1'
    let activeTabType: string | null = 'terminal'
    const switched: string[] = []
    return {
      setTabs(nextTabs: OpenedMobileSessionTabCandidate[]) {
        tabs = nextTabs
      },
      markActivated() {
        activated = true
      },
      supersedeActivation() {
        latestActivationSeq += 1
      },
      leaveSourceTerminal() {
        activeTerminalHandle = null
        activeTabType = 'file'
      },
      options(fetchSessionTabs: () => Promise<void>) {
        return {
          relativePath: 'src/app.ts',
          fetchSessionTabs,
          getTabs: () => tabs,
          getActiveTabId: () => activeTabId,
          getActivationState: () => ({
            activated,
            activationSeq,
            latestActivationSeq,
            sourceTerminalHandle: 'pty-1',
            activeTerminalHandle,
            activeTabType
          }),
          switchSessionTab: (tab: OpenedMobileSessionTabCandidate) => {
            activeTabId = tab.id
            activeTabType = tab.type
            activeTerminalHandle = null
            switched.push(tab.id)
            return true
          }
        }
      },
      switched
    }
  }

  it('refreshes tabs and switches to the opened file tab', async () => {
    const harness = createActivationHarness()

    const activated = await activateOpenedMobileSessionTab(
      harness.options(async () => {
        harness.setTabs([fileTab])
      })
    )

    expect(activated).toBe(true)
    expect(harness.switched).toEqual(['file-1'])
  })

  it('does not switch when a newer tap supersedes this attempt during refresh', async () => {
    const harness = createActivationHarness()

    const activated = await activateOpenedMobileSessionTab(
      harness.options(async () => {
        harness.setTabs([fileTab])
        harness.supersedeActivation()
      })
    )

    expect(activated).toBe(false)
    expect(harness.switched).toEqual([])
  })

  it('does not switch when the user leaves the source terminal during refresh', async () => {
    const harness = createActivationHarness()

    const activated = await activateOpenedMobileSessionTab(
      harness.options(async () => {
        harness.setTabs([fileTab])
        harness.leaveSourceTerminal()
      })
    )

    expect(activated).toBe(false)
    expect(harness.switched).toEqual([])
  })

  it('stops retrying after an earlier attempt already activated the tab', async () => {
    const harness = createActivationHarness()
    harness.markActivated()

    const activated = await activateOpenedMobileSessionTab(
      harness.options(async () => {
        harness.setTabs([fileTab])
      })
    )

    expect(activated).toBe(false)
    expect(harness.switched).toEqual([])
  })
})

describe('activateOpenedSourceControlDiffTab', () => {
  const diffTab = { type: 'file', id: 'diff-1', mode: 'diff', relativePath: 'src/app.ts' }

  function createSourceControlHarness() {
    let tabs: OpenedMobileSessionTabCandidate[] = []
    let activeTabId: string | null = 'terminal-1'
    let activated = false
    const activationSeq = 1
    let latestActivationSeq = 1
    const switched: string[] = []
    return {
      setTabs(nextTabs: OpenedMobileSessionTabCandidate[]) {
        tabs = nextTabs
      },
      setActiveTabId(id: string | null) {
        activeTabId = id
      },
      markActivated() {
        activated = true
      },
      supersedeActivation() {
        latestActivationSeq += 1
      },
      options(fetchSessionTabs: () => Promise<void>) {
        return {
          relativePath: 'src/app.ts',
          activeTabIdAtTap: 'terminal-1' as string | null,
          fetchSessionTabs,
          getTabs: () => tabs,
          getActiveTabId: () => activeTabId,
          getActivationState: () => ({ activated, activationSeq, latestActivationSeq }),
          switchSessionTab: (tab: OpenedMobileSessionTabCandidate) => {
            activeTabId = tab.id
            switched.push(tab.id)
          }
        }
      },
      switched
    }
  }

  it('refreshes tabs and switches to the opened diff tab', async () => {
    const harness = createSourceControlHarness()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([diffTab])
      })
    )

    expect(settled).toBe(true)
    expect(harness.switched).toEqual(['diff-1'])
  })

  it('prefers the opened diff over an existing edit tab for the same path', async () => {
    const harness = createSourceControlHarness()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([{ type: 'markdown', id: 'edit-1', relativePath: 'src/app.ts' }, diffTab])
      })
    )

    expect(settled).toBe(true)
    expect(harness.switched).toEqual(['diff-1'])
  })

  it('settles without switching when the snapshot already made the diff active', async () => {
    const harness = createSourceControlHarness()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([diffTab])
        harness.setActiveTabId('diff-1')
      })
    )

    expect(settled).toBe(true)
    expect(harness.switched).toEqual([])
  })

  it('does not steal focus when the user moved to a different tab after the tap', async () => {
    const harness = createSourceControlHarness()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([diffTab])
        harness.setActiveTabId('terminal-2')
      })
    )

    expect(settled).toBe(false)
    expect(harness.switched).toEqual([])
  })

  it('does not switch when a newer tap supersedes this attempt during refresh', async () => {
    const harness = createSourceControlHarness()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([diffTab])
        harness.supersedeActivation()
      })
    )

    expect(settled).toBe(false)
    expect(harness.switched).toEqual([])
  })

  it('stops retrying after an earlier attempt already activated the tab', async () => {
    const harness = createSourceControlHarness()
    harness.markActivated()

    const settled = await activateOpenedSourceControlDiffTab(
      harness.options(async () => {
        harness.setTabs([diffTab])
      })
    )

    expect(settled).toBe(false)
    expect(harness.switched).toEqual([])
  })
})

describe('shouldActivateOpenedMobileSessionTab', () => {
  const currentTerminalState = {
    activationSeq: 2,
    latestActivationSeq: 2,
    sourceTerminalHandle: 'pty-1',
    activeTerminalHandle: 'pty-1',
    activeTabType: 'terminal'
  }

  it('allows the latest tap while the source terminal is still active', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false
      })
    ).toBe(true)
  })

  it('stops later retries after the first successful activation', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: true
      })
    ).toBe(false)
  })

  it('prevents an older tap from stealing focus from a newer tap', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        activationSeq: 1
      })
    ).toBe(false)
  })

  it('does not activate after the user leaves the source terminal', () => {
    expect(
      shouldActivateOpenedMobileSessionTab({
        ...currentTerminalState,
        activated: false,
        activeTabType: 'file',
        activeTerminalHandle: null
      })
    ).toBe(false)
  })
})
