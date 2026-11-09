import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_WINDOWS_HOST_SCRIPT,
  type OrcadWindowsHostOp
} from '../host-state/orcad-windows-host-script'

const FAKE_ADDON_PRELOAD = [
  'const Module=require("module"),fs=require("fs");',
  'Module._extensions[".node"]=(m,f)=>{m.exports={getProcessCreationTime:(pid)=>{',
  'try{return JSON.parse(fs.readFileSync(f+".json","utf8"))[pid]}catch{return undefined}}}};'
].join('')

let dir = ''
let preload = ''
let script = ''
const children: { kill: () => boolean }[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orcad-win-scripts-'))
  preload = join(dir, 'fake-addon-preload.js')
  writeFileSync(preload, FAKE_ADDON_PRELOAD)
  script = join(dir, 'orcad-host-script.js')
  writeFileSync(script, ORCAD_WINDOWS_HOST_SCRIPT)
})

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill()
  }
  rmSync(dir, { recursive: true, force: true })
})

async function runOp(op: OrcadWindowsHostOp, args: string[], withAddon = true) {
  return runProcess({
    program: process.execPath,
    args: [...(withAddon ? ['--require', preload] : []), script, op, ...args],
    timeoutMs: 15_000
  })
}

describe('Windows record scripts', () => {
  it('publishes a staged record over the existing one', async () => {
    const path = join(dir, 'transaction.json')
    const staged = `${path}.partial.1.abc`
    writeFileSync(path, 'old')
    writeFileSync(staged, 'new')
    const result = await runOp('record-publish', [staged, path], false)
    expect(result.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(existsSync(staged)).toBe(false)
  })
})
