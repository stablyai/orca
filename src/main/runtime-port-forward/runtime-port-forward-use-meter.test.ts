import { describe, expect, it } from 'vitest'
import { ForwardUseMeter } from './runtime-port-forward-use-meter'

// Client-to-VM chunks ([ms, bytes]) recorded through a real forward (W3 perf, 2026-11-10): one
// minute of an idle openvscode-server 1.109 window over `ssh -L`, nobody touching it. 2.3 KB/min,
// above the old 2 KiB/min bar that kept such a VM awake.
const VSCODE_IDLE_MINUTE: [number, number][] = [
  [43, 52],
  [4865, 60],
  [4911, 44],
  [5042, 52],
  [9867, 60],
  [9909, 44],
  [10043, 52],
  [14871, 60],
  [14910, 44],
  [15044, 52],
  [19873, 60],
  [19911, 44],
  [20047, 52],
  [24876, 60],
  [24912, 44],
  [25043, 52],
  [29879, 60],
  [29910, 44],
  [30045, 52],
  [34883, 60],
  [34915, 44],
  [35043, 52],
  [36984, 60],
  [39053, 60],
  [39884, 60],
  [39910, 52],
  [40046, 52],
  [41125, 52],
  [43195, 60],
  [44885, 60],
  [44910, 52],
  [45047, 52],
  [45265, 52],
  [47339, 52],
  [49891, 60],
  [49911, 52],
  [50046, 52],
  [54897, 60],
  [54910, 44],
  [55048, 52],
  [59899, 60],
  [59907, 44]
]

// Typing in app.py at ~6 keys/s (same session, 3 s slice).
const VSCODE_TYPING: [number, number][] = [
  [138, 124],
  [144, 116],
  [297, 116],
  [455, 116],
  [607, 116],
  [766, 116],
  [894, 44],
  [923, 116],
  [978, 52],
  [1006, 52],
  [1079, 116],
  [1096, 116],
  [1096, 84],
  [1109, 220],
  [1163, 60],
  [1229, 68],
  [1236, 116],
  [1297, 60],
  [1365, 76],
  [1365, 76],
  [1372, 68],
  [1391, 116],
  [1430, 60],
  [1495, 84],
  [1542, 116],
  [1562, 60],
  [1702, 116],
  [1855, 116],
  [2010, 204],
  [2169, 116],
  [2323, 116],
  [2475, 116],
  [2628, 116],
  [2781, 116],
  [2935, 124],
  [2942, 124]
]

// One short line (`print("hi")`) typed and saved, the only input that minute (4 s slice).
const VSCODE_ONE_LINE: [number, number][] = [
  [107, 116],
  [244, 116],
  [353, 116],
  [476, 124],
  [598, 124],
  [614, 44],
  [701, 52],
  [724, 124],
  [737, 52],
  [845, 124],
  [966, 100],
  [991, 60],
  [1094, 100],
  [1216, 124],
  [1224, 60],
  [1289, 60],
  [1354, 84],
  [1429, 60],
  [1470, 60],
  [1496, 60],
  [1504, 84],
  [1504, 76],
  [1540, 84],
  [1570, 60],
  [1635, 92],
  [1744, 60],
  [3579, 52],
  [3852, 52]
]

/** Feeds a trace (repeated `minutes` times) and returns the times the meter reported use. */
function replay(trace: [number, number][], minutes = 1): number[] {
  const meter = new ForwardUseMeter()
  const uses: number[] = []
  for (let minute = 0; minute < minutes; minute += 1) {
    for (const [offset, bytes] of trace) {
      const at = minute * 60_000 + offset
      if (meter.note(at, bytes)) {
        uses.push(at)
      }
    }
  }
  return uses
}

/** Recorded shape of typing in an ssh shell: OpenSSH's 36 B keystroke-timing packets every ~21 ms. */
function sshTyping(ms: number): [number, number][] {
  return Array.from({ length: Math.floor(ms / 21) }, (_, index) => [index * 21, 36])
}

describe('ForwardUseMeter', () => {
  it('lets an idle VS Code window sleep, for as long as it stays open', () => {
    const bytes = VSCODE_IDLE_MINUTE.reduce((total, [, size]) => total + size, 0)
    expect(bytes).toBeGreaterThan(2048)
    expect(replay(VSCODE_IDLE_MINUTE, 30)).toEqual([])
  })

  it('lets ssh keepalives sleep', () => {
    const keepalives: [number, number][] = [
      [0, 52],
      [30_000, 52]
    ]
    expect(replay(keepalives, 30)).toEqual([])
  })

  it('reads typing in a shell as use within a second', () => {
    const uses = replay(sshTyping(5_000))
    expect(uses.length).toBeGreaterThan(0)
    expect(uses[0]).toBeLessThan(1_000)
  })

  it('reads typing in the editor as use within two seconds', () => {
    const uses = replay(VSCODE_TYPING)
    expect(uses.length).toBeGreaterThan(0)
    expect(uses[0]).toBeLessThan(2_000)
  })

  it('reads one short line typed and saved as use, even amid idle keepalives', () => {
    const line: [number, number][] = VSCODE_ONE_LINE.map(([at, bytes]) => [at + 20_100, bytes])
    const minute = [...VSCODE_IDLE_MINUTE, ...line].sort((a, b) => a[0] - b[0])
    expect(replay(minute).length).toBeGreaterThan(0)
  })

  it('forgets bytes older than its window', () => {
    const spread: [number, number][] = Array.from({ length: 6 }, (_, index) => [
      index * 11_000,
      300
    ])
    expect(replay(spread)).toEqual([])
  })
})
