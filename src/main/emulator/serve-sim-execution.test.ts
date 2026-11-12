import { expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { execServeSimCommand } from './serve-sim-execution'

// Shape of serve-sim 0.1.47's real `fold 180 -d <udid> -q` crash: the minified source line holds
// the "No serve-sim server running" text of every other command (#40509).
const UNCAUGHT_FOLD_FAILURE = `file:///Users/me/Library/Application Support/orca/serve-sim-runtime/1.4.255/node_modules/serve-sim/dist/serve-sim.js:161
Shutting down...\`);async function GG($,Q){let Z=s(Q);if(!Z)console.error("No serve-sim server running. Run \`serve-sim\` first."),process.exit(1);let J=await C5(Z.wsUrl)}


Error: Simulator rejected the fold. An iPhone Duo with guest HID support is required.
    at J.onmessage (file:///Users/me/Library/Application Support/orca/serve-sim-runtime/1.4.255/node_modules/serve-sim/dist/serve-sim.js:161:6107)
    at callListener (/Users/me/node_modules/ws/lib/event-target.js:290:14)

Node.js v24.22.1
`

it('reports the thrown serve-sim error instead of no active emulator', async () => {
  runProcessMock.mockResolvedValueOnce({
    code: 1,
    signal: null,
    stdout: '',
    stderr: UNCAUGHT_FOLD_FAILURE,
    timedOut: false
  })
  await expect(
    execServeSimCommand({ command: 'serve-sim', baseArgs: [], usesElectronAsNode: false }, [
      'fold',
      '180'
    ])
  ).rejects.toMatchObject({
    code: 'emulator_error',
    message: 'Error: Simulator rejected the fold. An iPhone Duo with guest HID support is required.'
  })
})
