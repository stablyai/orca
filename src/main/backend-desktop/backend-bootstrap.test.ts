import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { BackendBootstrapSchema } from '../../shared/backend-service-contract'
import { createDesktopBackendEnvironment } from '../backend/node-service-environment'
import { getLogsDirectory } from '../observability/logs-directory'
import { captureBackendBootstrap, capturedBootstrap } from './backend-bootstrap'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn<(name: string) => string>() }))
vi.mock('electron', () => ({
  app: {
    getPath,
    getVersion: () => '1.2.3',
    getAppPath: () => '/installed/orca',
    isPackaged: true
  }
}))

let originalEnvironment: ReturnType<typeof getAppEnvironment>
beforeEach(() => {
  originalEnvironment = getAppEnvironment()
  getPath.mockImplementation((name) => {
    if (name !== 'userData') {
      throw new Error(`Failed to get ${name} path`)
    }
    return '/profiles/usage-profile'
  })
})
afterEach(() => setAppEnvironment(originalEnvironment))

it('starts the usage environment at its authoritative profile when optional folders are unavailable', () => {
  captureBackendBootstrap()
  const config = BackendBootstrapSchema.parse(capturedBootstrap)
  const host = createDesktopBackendEnvironment(config)
  setAppEnvironment(host.environment)

  expect(getAppEnvironment().getPath('userData')).toBe('/profiles/usage-profile')
  expect(getLogsDirectory()).toBe(join('/profiles/usage-profile', 'logs'))
  expect(() => getAppEnvironment().getPath('downloads')).toThrow(
    'Desktop backend path is unsupported: downloads'
  )
})

it('fails startup preparation when the required profile is unavailable', () => {
  getPath.mockImplementation(() => {
    throw new Error('Failed to get userData path')
  })
  expect(captureBackendBootstrap).toThrow('Failed to get userData path')
})

it('accepts legacy full and minimal snapshots without a build restriction while requiring the profile', () => {
  captureBackendBootstrap()
  const minimal = BackendBootstrapSchema.parse(capturedBootstrap)
  const legacy = {
    ...minimal,
    build: 'older-shell',
    paths: {
      userData: '/profiles/legacy-profile',
      home: '/legacy/home',
      appData: '/legacy/appData',
      temp: '/legacy/temp',
      downloads: '/legacy/downloads',
      logs: '/legacy/logs',
      exe: '/legacy/orca'
    }
  }
  expect(
    createDesktopBackendEnvironment(BackendBootstrapSchema.parse(legacy)).environment.getPath(
      'userData'
    )
  ).toBe('/profiles/legacy-profile')
  expect(createDesktopBackendEnvironment(minimal).environment.getPath('userData')).toBe(
    '/profiles/usage-profile'
  )
  expect(BackendBootstrapSchema.safeParse({ ...minimal, paths: {} }).success).toBe(false)
})
