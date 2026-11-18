import { afterEach, expect, it } from 'vitest'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolateClaudeProfileHistory } from './claude-profile-private-history'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('detaches retired prompt hardlinks and broken shared project links while preserving private files', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-private-history-')))
  directories.push(root)
  const home = join(root, 'account')
  const shared = join(root, 'system')
  await mkdir(home)
  await mkdir(shared)
  await mkdir(join(shared, 'projects'))
  await symlink(
    join(shared, 'projects'),
    join(home, 'projects'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await rm(join(shared, 'projects'), { recursive: true })
  await writeFile(join(shared, 'history.jsonl'), 'retired personal prompts')
  await link(join(shared, 'history.jsonl'), join(home, 'history.jsonl'))
  const identity = await stat(join(home, 'history.jsonl'), { bigint: true })
  await writeFile(
    join(home, 'history.jsonl.orca-profile-link'),
    `${identity.dev}:${identity.ino}\n`
  )
  await writeFile(join(shared, 'replacement'), 'new personal prompts')
  await rename(join(shared, 'replacement'), join(shared, 'history.jsonl'))
  await mkdir(join(home, 'file-history'))
  await writeFile(join(home, 'file-history', 'private'), 'private account file')
  await isolateClaudeProfileHistory(home, shared)
  expect(await readFile(join(home, 'history.jsonl'), 'utf8')).toBe('')
  expect(await readFile(join(shared, 'history.jsonl'), 'utf8')).toBe('new personal prompts')
  expect(await readFile(join(home, 'file-history', 'private'), 'utf8')).toBe('private account file')
  expect((await stat(join(home, 'projects'))).isDirectory()).toBe(true)
})

it('keeps formerly shared conversations resumable in an independent private projects directory', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-private-resume-')))
  directories.push(root)
  const home = join(root, 'account')
  const shared = join(root, 'system')
  await mkdir(home)
  await mkdir(join(shared, 'projects', 'project'), { recursive: true })
  await writeFile(join(shared, 'projects', 'project', 'session.jsonl'), 'existing conversation\n')
  await symlink(
    join(shared, 'projects'),
    join(home, 'projects'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await isolateClaudeProfileHistory(home, shared)
  expect(await readFile(join(home, 'projects', 'project', 'session.jsonl'), 'utf8')).toBe(
    'existing conversation\n'
  )
  await writeFile(join(home, 'projects', 'project', 'session.jsonl'), 'private continuation\n')
  await isolateClaudeProfileHistory(home, shared)
  expect(await readFile(join(shared, 'projects', 'project', 'session.jsonl'), 'utf8')).toBe(
    'existing conversation\n'
  )
  expect(await readFile(join(home, 'projects', 'project', 'session.jsonl'), 'utf8')).toBe(
    'private continuation\n'
  )
})
