import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { wslScriptFixture } from './native-wsl-credential-script-fixtures'
import { credential } from './native-account-test-fixtures'
import { decodeAntigravityWslReply } from './native-wsl-credential-protocol'

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
describe.skipIf(process.platform === 'win32')('private guest HOME isolation', () => {
  let first: Awaited<ReturnType<typeof wslScriptFixture>>
  let second: Awaited<ReturnType<typeof wslScriptFixture>>
  beforeEach(async () => {
    first = await wslScriptFixture()
    second = await wslScriptFixture()
  })
  afterEach(async () => {
    await first.clean()
    await second.clean()
  })
  it('keeps independent credential authorities unchanged on switch, conflict and cleanup', async () => {
    await first.put(credential('first'))
    await second.put(credential('second'))
    const before = digest(await readFile(second.path))
    expect((await first.run('write', credential('replacement'), credential('first'))).code).toBe(0)
    expect((await first.run('write', credential('stale'), credential('first'))).code).toBe(73)
    expect(digest(await readFile(second.path))).toBe(before)
    await first.clean()
    expect(digest(await readFile(second.path))).toBe(before)
    const read = await second.run('read')
    expect(decodeAntigravityWslReply(read.stdout, 'abc123')).toEqual({
      status: 'present',
      contents: credential('second')
    })
  })
})
