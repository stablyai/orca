import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  prepareAntigravityChatReauthentication,
  recoverAntigravityChatToken
} from './antigravity-chat-reauthentication'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

async function account() {
  const home = await mkdtemp(join(tmpdir(), 'orca-agy-reauth-'))
  homes.push(home)
  const acp = join(home, 'antigravity-acp')
  await mkdir(acp, { mode: 0o700 })
  const token = join(acp, 'acp_token.json')
  return { home, acp, token, backup: `${token}.orca-sign-in-backup` }
}

it('rolls back partial credentials without changing settings or conversation files', async () => {
  const { home, acp, token } = await account()
  const settings = join(acp, 'settings.json')
  const conversation = join(acp, 'conversation.db')
  await writeFile(token, 'previous-token', { mode: 0o600 })
  await writeFile(settings, 'settings')
  await writeFile(conversation, 'conversation')
  const finish = await prepareAntigravityChatReauthentication(home)
  await expect(readFile(token)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(token, 'partially-authenticated-token')
  await finish(false)
  expect(await readFile(token, 'utf8')).toBe('previous-token')
  expect(await readFile(settings, 'utf8')).toBe('settings')
  expect(await readFile(conversation, 'utf8')).toBe('conversation')
})

it('recovers the previous account after an interrupted switch', async () => {
  const { home, token, backup } = await account()
  await writeFile(token, 'previous-token', { mode: 0o600 })
  await prepareAntigravityChatReauthentication(home)
  await writeFile(token, 'unverified-token')
  await recoverAntigravityChatToken(home)
  expect(await readFile(token, 'utf8')).toBe('previous-token')
  await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes partial credentials after a failed first sign-in', async () => {
  const { home, token } = await account()
  const finish = await prepareAntigravityChatReauthentication(home)
  await writeFile(token, 'unverified-token')
  await finish(false)
  await expect(readFile(token)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')(
  'refuses a symlink without touching its target',
  async () => {
    const { home, token } = await account()
    const external = join(home, 'other-agent-token')
    await writeFile(external, 'other-agent-token')
    await symlink(external, token)
    await expect(prepareAntigravityChatReauthentication(home)).rejects.toThrow('not a regular file')
    expect(await readFile(external, 'utf8')).toBe('other-agent-token')
  }
)
