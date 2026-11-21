import { expect, it } from 'vitest'
import { KIRO_ACP_DIALECT } from './kiro-dialect'

it("names a diff's file by path, not the file URI Kiro sends", () => {
  const update = KIRO_ACP_DIALECT.normalizeToolUpdate!({
    toolCallId: 'tooluse_1',
    status: 'completed',
    content: [
      { type: 'diff', path: 'file:///c:/work/kiro-fixture/probe.txt', oldText: null, newText: 'hi' }
    ]
  })
  // A drive-letter URI decodes on every platform; POSIX keeps it as a rooted path.
  expect(update.content).toEqual([
    {
      type: 'diff',
      path:
        process.platform === 'win32'
          ? 'c:\\work\\kiro-fixture\\probe.txt'
          : '/c:/work/kiro-fixture/probe.txt',
      oldText: null,
      newText: 'hi'
    }
  ])
})
