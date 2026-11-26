import { captureJournalLegacySourceReceipt } from './database/journal-legacy-source-capture'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import {
  acquireJournalLegacyFileLock,
  createJournalLegacyFileEligibility,
  journalLegacyFileLockPath
} from './journal-legacy-file-lock'
import { openJournalDatabase } from './database/journal-database'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

it.skipIf(process.env.ORCA_JOURNAL_NATIVE_LOCK_TEST !== '1')(
  'excludes a real SQLite process without altering source bytes, then releases on EOF',
  async () => {
    expect(existsSync(await journalLegacyFileLockPath())).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'orca-journal-file-lock-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const filename = join(root, 'source.db')
    const { db } = openJournalDatabase(filename)
    db.exec(
      "CREATE TABLE fixture_history(value TEXT); INSERT INTO fixture_history VALUES('history never opened')"
    )
    db.close()
    const script = join(root, 'reader.cjs')
    writeFileSync(
      script,
      "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[2], {readOnly:true});db.prepare('SELECT * FROM fixture_history').get();process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>{db.close()});"
    )
    const reader = spawnProcess({
      program: process.execPath,
      args: [script, filename],
      stdio: 'pipe'
    })
    const exited = new Promise<void>((resolve, reject) => {
      reader.once('error', reject)
      reader.once('exit', () => resolve())
    })
    cleanups.push(async () => {
      reader.stdin.end()
      await exited
    })
    await new Promise<void>((resolve, reject) => {
      reader.stdout.once('data', () => resolve())
      reader.once('error', reject)
    })
    const signal = new AbortController()
    await createJournalLegacyFileEligibility().check(filename, signal.signal)
    await expect(acquireJournalLegacyFileLock(filename, signal.signal)).rejects.toThrow()
    reader.stdin.end()
    await exited
    const before = readFileSync(filename)
    const identity = captureJournalLegacySourceReceipt(filename)
    const lock = await acquireJournalLegacyFileLock(filename, signal.signal)
    try {
      expect(lock.held()).toBe(true)
      expect(captureJournalLegacySourceReceipt(filename)).toEqual(identity)
      const contender = spawnProcess({
        program: process.execPath,
        args: [
          '-e',
          "const{DatabaseSync}=require('node:sqlite');let db;try{db=new DatabaseSync(process.argv[1],{readOnly:true});db.prepare('SELECT * FROM fixture_history').get();process.stdout.write('opened')}catch{process.stdout.write('blocked')}finally{db?.close()}",
          filename
        ],
        stdio: 'pipe'
      })
      contender.stdin.end()
      const output = await new Promise<string>((resolve, reject) => {
        let result = ''
        contender.stdout.on('data', (chunk) => {
          result += chunk.toString()
        })
        contender.stderr.resume()
        contender.once('error', reject)
        contender.once('exit', () => resolve(result))
      })
      expect(output).toBe('blocked')
    } finally {
      await lock.close()
    }
    expect(readFileSync(filename)).toEqual(before)
    // A WAL that holds frames keeps everything; an empty one goes with the file it belongs to.
    writeFileSync(`${filename}-wal`, 'frames')
    const refused = await acquireJournalLegacyFileLock(filename, signal.signal)
    await expect(refused.retire('0')).rejects.toThrow('legacy companions still hold data')
    expect(existsSync(filename)).toBe(true)
    writeFileSync(`${filename}-wal`, '')
    writeFileSync(`${filename}-shm`, '')
    const retiring = await acquireJournalLegacyFileLock(filename, signal.signal)
    expect(await retiring.retire('0')).toBe(true)
    expect([filename, `${filename}-wal`, `${filename}-shm`].filter((f) => existsSync(f))).toEqual(
      []
    )
  }
)
