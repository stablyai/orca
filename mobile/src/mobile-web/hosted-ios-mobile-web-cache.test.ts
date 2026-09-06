import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readIosActivation,
  readIosRollbackActivation
} from '../../scripts/hosted-ios-mobile-web-cache.mjs'
import { selectHostedIosWebContentPid } from '../../scripts/hosted-ios-webcontent-process.mjs'

const active = 'a'.repeat(64)
const previous = 'b'.repeat(64)
const temporaryRoots: string[] = []
const harnessSource = readFileSync(
  new URL('../../scripts/run-hosted-ios-webview-crash-loop.mjs', import.meta.url),
  'utf8'
)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('hosted iOS mobile web cache evidence', () => {
  it('selects the only host with an active and previous generation', async () => {
    const root = await createAppData()
    await writeActivation(root, '1'.repeat(64), { active })
    const candidate = await writeActivation(root, '2'.repeat(64), { active, previous })

    await expect(readIosRollbackActivation(root)).resolves.toEqual({
      path: candidate,
      active,
      previous
    })
  })

  it('normalizes an omitted previous generation and rejects invalid identities', async () => {
    const root = await createAppData()
    const valid = await writeActivation(root, '1'.repeat(64), { active })
    const invalid = await writeActivation(root, '2'.repeat(64), { active: '../active' })

    await expect(readIosActivation(valid)).resolves.toEqual({ active, previous: null })
    await expect(readIosActivation(invalid)).rejects.toThrow(
      'iOS cache returned an invalid activation record'
    )
  })

  it('selects only the simulator WebContent child', () => {
    const processes = [
      '  100 1 /System/Library/com.apple.WebKit.WebContent',
      '  200 67323 /Runtime/WebContentExtension.appex/com.apple.WebKit.WebContent -LaunchArguments',
      '  300 90000 /Runtime/WebContentExtension.appex/com.apple.WebKit.WebContent -LaunchArguments'
    ].join('\n')

    expect(selectHostedIosWebContentPid(processes, 67323)).toBe(200)
    expect(() => selectHostedIosWebContentPid(`${processes}\n${processes}`, 67323)).toThrow(
      'Expected one iOS WebContent process, found 2'
    )
  })

  it('kills three WebContent processes and requires native activation rollback', () => {
    expect(harnessSource).toContain('const failureCount = 3')
    expect(harnessSource).toContain('terminateHostedIosWebContent(deviceUdid)')
    expect(harnessSource).toContain('initial.previous')
    expect(harnessSource).toContain('waitForIosActivation(')
    expect(harnessSource).toContain('>= 60_000')
    expect(harnessSource).toContain('documents.at(-1)?.href === documents[0]?.href')
  })
})

async function createAppData() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-ios-cache-evidence-'))
  temporaryRoots.push(root)
  return root
}

async function writeActivation(
  root: string,
  hostIdentity: string,
  value: { active: string; previous?: string }
) {
  const hostRoot = path.join(root, 'Library', 'Application Support', 'OrcaMobileWeb', hostIdentity)
  await mkdir(hostRoot, { recursive: true })
  const activationPath = path.join(hostRoot, 'activation.json')
  await writeFile(activationPath, JSON.stringify(value))
  return activationPath
}
