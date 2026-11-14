import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

type RuntimeClientModule = typeof RuntimeClientExports

vi.mock('../runtime/client', async (importOriginal) => ({
  ...(await importOriginal<RuntimeClientModule>()),
  RuntimeClient: class {
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
}))

import { main } from '../index'
import type * as RuntimeClientExports from '../runtime/client'
import { RuntimeRpcFailureError } from '../runtime/types'
import { okFixture, queueFixtures } from '../runtime/fixtures/runtime-rpc-fixtures'

describe('orca computer wait', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('polls until the text appears, waiting out a window that is not open yet', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req_0',
        ok: false,
        error: { code: 'window_not_found', message: 'no window' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    queueFixtures(
      callMock,
      okFixture('req_1', snapshot('0 window Editor\n\t1 text Saving…')),
      okFixture('req_2', snapshot('0 window Editor\n\t1 text All changes saved\n\t2 button Close'))
    )

    await run('--text', 'saved')

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(callMock).toHaveBeenLastCalledWith(
      'computer.getAppState',
      { session: 'manual', app: 'TextEdit', noScreenshot: true },
      expect.anything()
    )
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.result.wait).toMatchObject({ kind: 'text', value: 'saved' })
    expect(output.result.snapshot.treeText).toContain('1 text All changes saved')
    expect(output.result.snapshot.treeText).not.toContain('2 button Close')
  })

  it('waits until every element containing the text is enabled', async () => {
    queueFixtures(
      callMock,
      okFixture('req_caps', capabilities(true)),
      okFixture(
        'req_1',
        snapshot('0 window Form\n\t1 text Press Continue\n\t2 button (disabled) Continue')
      ),
      okFixture('req_2', snapshot('0 window Form\n\t1 text Press Continue\n\t2 button Continue'))
    )

    await run('--enabled', 'Continue')

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(process.exitCode).toBeUndefined()
  })

  it('reads disabled state from the host, not from a label holding "(disabled)"', async () => {
    const tree = '0 window Form\n\t1 push button Continue (disabled)'
    queueFixtures(
      callMock,
      okFixture('req_caps', capabilities(true)),
      okFixture('req_1', snapshot(tree, [1])),
      okFixture('req_2', snapshot(tree, []))
    )

    await run('--enabled', 'Continue', '--timeout', '1000')

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(process.exitCode).toBeUndefined()
  })

  it('refuses --enabled on a provider that does not mark disabled elements', async () => {
    queueFixtures(callMock, okFixture('req_caps', capabilities(undefined)))

    await run('--enabled', 'Continue')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(1)
    expect(errorOutput()).toContain('unsupported_capability')
  })

  it('fails with wait_timeout and what it last saw', async () => {
    callMock.mockResolvedValue(okFixture('req_1', snapshot('0 window Editor\n\t1 text Saving…')))

    await run('--text', 'saved', '--timeout', '1')

    expect(process.exitCode).toBe(1)
    const error = errorOutput()
    expect(error).toContain('wait_timeout')
    expect(error).toContain('no element contains \\"saved\\"')
  })

  it('waits for a window title across the app windows', async () => {
    queueFixtures(
      callMock,
      okFixture('req_1', windows(['Untitled'])),
      okFixture('req_2', windows(['Untitled', 'Save As']))
    )

    await run('--window-title', 'save as')

    expect(callMock).toHaveBeenLastCalledWith(
      'computer.listWindows',
      { app: 'TextEdit' },
      expect.anything()
    )
    const output = JSON.parse(vi.mocked(console.log).mock.calls[0][0])
    expect(output.result.windows.map((window: { title: string }) => window.title)).toEqual([
      'Save As'
    ])
  })
})

async function run(...args: string[]): Promise<void> {
  await main(
    ['computer', 'wait', '--session', 'manual', '--app', 'TextEdit', ...args, '--json'],
    '/tmp/repo'
  )
}

function errorOutput(): string {
  return vi
    .mocked(console.log)
    .mock.calls.map((call) => String(call[0]))
    .join('\n')
}

function snapshot(treeText: string, disabledElementIndexes?: number[]) {
  return {
    snapshot: {
      id: 'snap',
      app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 7 },
      window: { title: 'Editor', width: 800, height: 600 },
      coordinateSpace: 'window',
      treeText: `App=com.apple.TextEdit (pid 7)\nWindow: "Editor"\n\n${treeText}`,
      elementCount: 3,
      focusedElementId: null,
      disabledElementIndexes
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

function capabilities(disabledState: boolean | undefined) {
  return {
    platform: 'linux',
    provider: 'orca-computer-use-linux',
    providerVersion: '1',
    protocolVersion: 1,
    supports: { observation: { screenshot: true, disabledState } }
  }
}

function windows(titles: string[]) {
  return {
    app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 7 },
    windows: titles.map((title, index) => ({ title, index, id: index, width: 800, height: 600 }))
  }
}
