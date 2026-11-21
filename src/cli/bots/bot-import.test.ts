import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime/client'
import { BOT_IMPORT_HANDLERS } from './bot-import'

describe('bot import read', () => {
  let root: string
  let out: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bot-import-read-'))
    out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk)
      return true
    })
    await mkdir(join(root, 'credentials'))
    await writeFile(join(root, 'credentials', 'service.json'), '{"noiseKey":"canary-symlink"}')
    await mkdir(join(root, 'export'))
    await writeFile(join(root, 'export', 'notes.md'), 'Deploy freeze is Thursdays.')
    // A file link needs the symlink privilege on Windows, so the file-linked fixtures are made
    // only where they can be. The directory link below covers the same never-read rule there.
    if (process.platform !== 'win32') {
      await symlink(join(root, 'export', 'notes.md'), join(root, 'export', 'USER.md'))
      await symlink(join(root, 'credentials', 'service.json'), join(root, 'export', 'MEMORY.md'))
    }
    // 'junction' creates a directory link without the symlink privilege Windows otherwise needs.
    await symlink(
      join(root, 'credentials'),
      join(root, 'export', 'memory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  function read(path: string): Promise<void> {
    return BOT_IMPORT_HANDLERS['bot import read']({
      flags: new Map([['path', path]]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `bot import read` never calls the runtime.
      client: {} as RuntimeClient,
      cwd: root,
      json: false
    })
  }

  // The two file links this case reads cannot be made on Windows; the directory-link case below
  // still exercises the never-read rule there.
  it.skipIf(process.platform === 'win32')(
    'refuses a link whose target is on the never-read list, and reads a benign one',
    async () => {
      await expect(read('export/MEMORY.md')).rejects.toThrow(/Not read/)
      await expect(read('export/memory/service.json')).rejects.toThrow(/Not read/)
      await read('export/USER.md')
      expect(out).toBe('Deploy freeze is Thursdays.\n')
    }
  )

  it('marks links to never-read targets in a folder listing', async () => {
    await read('export')
    expect(out).toMatch(/^memory {2}\(never read/m)
    if (process.platform !== 'win32') {
      expect(out).toMatch(/^MEMORY\.md {2}\(never read/m)
      expect(out).toMatch(/^USER\.md$/m)
    }
  })
})

describe('the bot-import reading guide', () => {
  it("sends every command that prints the old app's data through the reader", async () => {
    const guide = await readFile(
      join(__dirname, '../../../skill-guides/orca-cli/references/bot-import.md'),
      'utf8'
    )
    const reading = guide.slice(guide.indexOf('## 2. Read'), guide.indexOf('## 3.'))
    const commands = [...reading.matchAll(/`((?:openclaw|jq|awk|sqlite3) [^`]+)`/g)].map(
      (m) => m[1]
    )
    expect(commands.length).toBeGreaterThan(4)
    for (const command of commands) {
      expect(command, command).toMatch(/\| ORCA bot import read -$/)
    }
  })
})
