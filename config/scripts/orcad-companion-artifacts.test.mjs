import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import { writeOpenCodeSqliteDatabase } from '../../src/main/ai-vault/session-scanner-opencode-sqlite-fixture'
import { buildOpenCodeSqliteCandidatePath } from '../../src/main/ai-vault/session-scanner-opencode-sqlite-paths'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts'

const directory = resolve('out/orcad')
const runtime = join(directory, orcadBunRuntimeFilename(process.platform))
const entries = [
  'session-scanner-service-entry.js',
  'session-scanner-worker-entry.js',
  'session-scanner-opencode-sqlite-worker-entry.js',
  'session-scanner-opencode-sqlite-process-entry.js',
  'wsl-transcript-fs-process-entry.js',
  'port-scan-command-worker-entry.js'
]

const built = existsSync(join(directory, '.version'))
const required = process.env.ORCA_TEST_REQUIRE_ORCAD_ARTIFACTS === '1'

describe.skipIf(!built && !required)('packaged orcad companion processes', () => {
  it('reads a transcript and executes a probe without checkout dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca companion artifacts '))
    try {
      for (const entry of entries) {
        await copyFile(join(directory, entry), join(root, entry))
      }
      await writeFile(
        join(root, 'session.jsonl'),
        [
          { type: 'session_meta', payload: { id: 'companion-test', cwd: root } },
          {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'companion transcript' }]
            }
          }
        ]
          .map((line) => JSON.stringify(line))
          .join('\n')
      )
      const database = join(root, 'opencode.db')
      writeOpenCodeSqliteDatabase(database, [
        {
          id: 'sqlite-companion',
          turns: [{ role: 'user', parts: ['sqlite companion prompt'] }]
        }
      ])
      await writeFile(
        join(root, 'sqlite-request.json'),
        JSON.stringify({
          agent: 'opencode',
          sessionId: 'sqlite-companion',
          filePath: buildOpenCodeSqliteCandidatePath(database, 'sqlite-companion')
        })
      )
      const result = await runProcess({
        program: runtime,
        cwd: root,
        args: [
          '-e',
          `
          const { fork } = require('node:child_process')
          const { Worker } = require('node:worker_threads')
          const { join } = require('node:path')
          const { readFileSync } = require('node:fs')
          const root = process.cwd()
          const service = fork(join(root, 'session-scanner-service-entry.js'), [], {
            execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          })
          service.stderr.pipe(process.stderr)
          const prompt = new Promise((resolve, reject) => {
            let transcriptPrompt
            service.on('error', reject)
            service.on('exit', code => { if (code !== 0) reject(new Error('service exit ' + code)) })
            service.on('message', message => {
              if (message.type === 'ready') service.send({
                type: 'request', operation: 'firstPrompt', id: 1,
                request: { agent: 'codex', filePath: join(root, 'session.jsonl') }
              })
              if (message.type === 'error') reject(new Error(message.message))
              if (message.type === 'result' && message.id === 1) {
                transcriptPrompt = message.value.prompt
                service.send({ type: 'request', operation: 'firstPrompt', id: 2,
                  request: JSON.parse(readFileSync(join(root, 'sqlite-request.json'), 'utf8')) })
              }
              if (message.type === 'result' && message.id === 2) {
                resolve({ transcriptPrompt, sqlitePrompt: message.value.prompt })
              }
            })
            service.send({ type: 'init', protocol: 1, sessionParseCache: null, sessionSearch: null })
          })
          const worker = new Worker(join(root, 'port-scan-command-worker-entry.js'))
          const probe = new Promise((resolve, reject) => {
            worker.on('error', reject)
            worker.once('message', response => response.ok ? resolve(response.stdout.trim()) : reject(new Error(response.error)))
            worker.postMessage({ id: 1, command: process.execPath, args: ['--version'] })
          })
          const scanner = new Worker(join(root, 'session-scanner-worker-entry.js'))
          const titles = new Promise((resolve, reject) => {
            scanner.on('error', reject)
            scanner.once('message', response => response.ok ? resolve(response.value.titles) : reject(new Error(response.error)))
            scanner.postMessage({ id: 1, kind: 'titles', requests: [{
              agent: 'codex', sessionId: 'companion-test', transcriptPath: join(root, 'session.jsonl')
            }] })
          })
          Promise.all([prompt, probe, titles]).then(async ([prompt, probe, titles]) => {
            service.send({ type: 'shutdown' })
            await Promise.all([worker.terminate(), scanner.terminate()])
            console.log(JSON.stringify({ prompt, probe, titles, bun: process.versions.bun }))
          }).catch(error => { console.error(error); service.kill(); worker.terminate(); scanner.terminate(); process.exitCode = 1 })
        `
        ],
        timeoutMs: 20_000
      })
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      const response = JSON.parse(result.stdout)
      expect(response.prompt).toEqual({
        transcriptPrompt: 'companion transcript',
        sqlitePrompt: 'sqlite companion prompt'
      })
      expect(response.probe).toBe(response.bun)
      expect(response.titles).toEqual([
        { agent: 'codex', sessionId: 'companion-test', title: 'companion transcript' }
      ])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })
})
