import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetProjectConfigCache,
  readProjectGiteaConfig,
  resolveGiteaAuth
} from './project-config'

const OLD_ENV = process.env

describe('project-config', () => {
  let repoPath: string

  beforeEach(async () => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    _resetProjectConfigCache()
    repoPath = await mkdtemp(join(tmpdir(), 'orca-gitea-project-config-'))
  })

  afterEach(async () => {
    process.env = OLD_ENV
    _resetProjectConfigCache()
    await rm(repoPath, { recursive: true, force: true })
  })

  describe('readProjectGiteaConfig', () => {
    it('returns null when .orca/gitea.json does not exist', async () => {
      await expect(readProjectGiteaConfig(repoPath)).resolves.toBeNull()
    })

    it('reads token and apiBaseUrl from .orca/gitea.json', async () => {
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'project-token', apiBaseUrl: 'https://gitea.example.com' })
      )

      await expect(readProjectGiteaConfig(repoPath)).resolves.toEqual({
        token: 'project-token',
        apiBaseUrl: 'https://gitea.example.com'
      })
    })

    it('returns null for empty or whitespace-only values', async () => {
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: '  ', apiBaseUrl: '' })
      )

      await expect(readProjectGiteaConfig(repoPath)).resolves.toBeNull()
    })

    it('returns null for invalid JSON', async () => {
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(join(repoPath, '.orca', 'gitea.json'), 'not json')

      await expect(readProjectGiteaConfig(repoPath)).resolves.toBeNull()
    })

    it('caches the result per repoPath', async () => {
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'cached-token' })
      )

      const first = await readProjectGiteaConfig(repoPath)
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'changed-token' })
      )
      const second = await readProjectGiteaConfig(repoPath)

      expect(first).toEqual({ token: 'cached-token' })
      expect(second).toEqual(first)
    })
  })

  describe('resolveGiteaAuth', () => {
    it('falls back to env vars when no repoPath is provided', async () => {
      process.env.ORCA_GITEA_TOKEN = 'env-token'
      process.env.ORCA_GITEA_API_BASE_URL = 'https://env.example.com'

      await expect(resolveGiteaAuth()).resolves.toEqual({
        token: 'env-token',
        apiBaseUrl: 'https://env.example.com/api/v1'
      })
    })

    it('falls back to env vars when .orca/gitea.json does not exist', async () => {
      process.env.ORCA_GITEA_TOKEN = 'env-token'

      await expect(resolveGiteaAuth(repoPath)).resolves.toEqual({
        token: 'env-token',
        apiBaseUrl: null
      })
    })

    it('uses project config token over env var', async () => {
      process.env.ORCA_GITEA_TOKEN = 'env-token'
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'project-token' })
      )

      await expect(resolveGiteaAuth(repoPath)).resolves.toEqual({
        token: 'project-token',
        apiBaseUrl: null
      })
    })

    it('uses project config apiBaseUrl over env var', async () => {
      process.env.ORCA_GITEA_API_BASE_URL = 'https://env.example.com'
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'project-token', apiBaseUrl: 'https://project.example.com' })
      )

      await expect(resolveGiteaAuth(repoPath)).resolves.toEqual({
        token: 'project-token',
        apiBaseUrl: 'https://project.example.com/api/v1'
      })
    })

    it('falls back to env apiBaseUrl when project config only sets token', async () => {
      process.env.ORCA_GITEA_API_BASE_URL = 'https://env.example.com'
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ token: 'project-token' })
      )

      await expect(resolveGiteaAuth(repoPath)).resolves.toEqual({
        token: 'project-token',
        apiBaseUrl: 'https://env.example.com/api/v1'
      })
    })

    it('does not send global env token to a project-controlled apiBaseUrl', async () => {
      process.env.ORCA_GITEA_TOKEN = 'env-token'
      process.env.ORCA_GITEA_API_BASE_URL = 'https://env.example.com'
      await mkdir(join(repoPath, '.orca'), { recursive: true })
      await writeFile(
        join(repoPath, '.orca', 'gitea.json'),
        JSON.stringify({ apiBaseUrl: 'https://project.example.com' })
      )

      await expect(resolveGiteaAuth(repoPath)).resolves.toEqual({
        token: null,
        apiBaseUrl: 'https://project.example.com/api/v1'
      })
    })
  })
})
