import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  parseExternalAcpProfileArgs,
  readExternalAcpProfile,
  validateExternalAcpProfile
} from './external-acp-profile.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function modelFields(root: string) {
  return {
    nativeCommand: join(root, 'native-server'),
    nativeHome: join(root, 'profile-home'),
    gatewayBaseUrl: 'https://gateway.example.test/v1',
    modelIds: ['model-alpha', 'pi'],
    defaultModel: 'model-alpha-high',
    timeoutMs: 40
  }
}

it('accepts only absolute per-profile homes and literal external gateway configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-acp-profile-'))
  roots.push(root)
  const profile = validateExternalAcpProfile(modelFields(root))
  expect(profile.modelIds).toEqual(['model-alpha', 'pi'])
  expect(profile.defaultModel).toBe('model-alpha-high')
  expect(profile.openAiChatUrl).toBe('https://gateway.example.test/v1/chat/completions')
  expect(profile.gatewayBaseUrl).toBe('')
  expect(profile.timeoutMs).toBe(40)
  expect(parseExternalAcpProfileArgs(['--profile', join(root, 'profile.json')])).toBe(
    join(root, 'profile.json')
  )
  expect(parseExternalAcpProfileArgs(['--profile', join(root, 'profile.json'), '--uid='])).toBe(
    join(root, 'profile.json')
  )
  expect(parseExternalAcpProfileArgs(['--profile', join(root, 'profile.json'), '--uid='])).toBe(
    join(root, 'profile.json')
  )
  expect(() => parseExternalAcpProfileArgs(['--profile', 'relative.json'])).toThrow()
  expect(() => validateExternalAcpProfile({ ...modelFields(root), nickname: 'shared' })).toThrow()
  expect(() =>
    validateExternalAcpProfile({ ...modelFields(root), nativeHome: 'shared-home' })
  ).toThrow()
  expect(() =>
    validateExternalAcpProfile({ ...modelFields(root), gatewayBaseUrl: 'file:///gateway' })
  ).toThrow()
  expect(() => validateExternalAcpProfile({ ...modelFields(root), modelIds: [] })).toThrow()
  expect(() =>
    validateExternalAcpProfile({ ...modelFields(root), nativeArgs: ['--api-key=x'] })
  ).toThrow()
  expect(
    validateExternalAcpProfile({ ...modelFields(root), nativeArgs: ['--debug'] }).nativeArgs
  ).toEqual(['--debug'])
  expect(() => validateExternalAcpProfile({ ...modelFields(root), modelIds: undefined })).toThrow()
  expect(() =>
    validateExternalAcpProfile({
      ...modelFields(root),
      gatewayBaseUrl: 'http://gateway.example.test'
    })
  ).toThrow()
  expect(() =>
    validateExternalAcpProfile({
      ...modelFields(root),
      gatewayBaseUrl: 'https://gateway.example.test/v1?credential=persisted'
    })
  ).toThrow()
  expect(() =>
    validateExternalAcpProfile({ ...modelFields(root), defaultModel: 'another model' })
  ).toThrow()
  for (const defaultModel of [123, true, null, ['model-alpha-high']]) {
    expect(() => validateExternalAcpProfile({ ...modelFields(root), defaultModel })).toThrow()
  }
  expect(
    validateExternalAcpProfile({ ...modelFields(root), defaultModel: undefined }).defaultModel
  ).toBe('model-alpha')
})

it('fails profile reads when the native command is missing and never executes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-acp-profile-read-'))
  roots.push(root)
  const path = join(root, 'profile.json')
  await writeFile(path, JSON.stringify(modelFields(root)))
  await expect(readExternalAcpProfile(path)).rejects.toThrow('external ACP profile is invalid')
  const nativeCommand = join(root, 'native-server')
  await writeFile(nativeCommand, '', { mode: 0o700 })
  await expect(readExternalAcpProfile(path)).resolves.toMatchObject({ nativeCommand })
})
