import { describe, expect, it } from 'vitest'
import {
  createChromeLaunchUrlConfig,
  createNodeAttachConfig,
  createNodeLaunchScriptConfig
} from './js-debug-launch-config-templates'

describe('createNodeLaunchScriptConfig', () => {
  it('builds a pwa-node launch config with the given program/cwd/args/env', () => {
    const config = createNodeLaunchScriptConfig({
      program: '/repo/src/index.js',
      cwd: '/repo',
      args: ['--flag'],
      env: { NODE_ENV: 'test' }
    })
    expect(config.type).toBe('node')
    expect(config.request).toBe('launch')
    expect(config.adapterArgs).toMatchObject({
      type: 'pwa-node',
      request: 'launch',
      program: '/repo/src/index.js',
      cwd: '/repo',
      args: ['--flag'],
      env: { NODE_ENV: 'test' },
      stopOnEntry: false
    })
  })

  it('defaults stopOnEntry to false and name to the program path', () => {
    const config = createNodeLaunchScriptConfig({ program: '/repo/a.js' })
    expect(config.adapterArgs).toMatchObject({ name: '/repo/a.js', stopOnEntry: false })
  })
})

describe('createNodeAttachConfig', () => {
  it('defaults to the conventional --inspect port and localhost', () => {
    const config = createNodeAttachConfig()
    expect(config.type).toBe('node')
    expect(config.request).toBe('attach')
    expect(config.adapterArgs).toMatchObject({
      type: 'pwa-node',
      request: 'attach',
      port: 9229,
      address: 'localhost'
    })
  })

  it('honors an explicit port/address', () => {
    const config = createNodeAttachConfig({ port: 9333, address: '10.0.0.5' })
    expect(config.adapterArgs).toMatchObject({ port: 9333, address: '10.0.0.5' })
  })
})

describe('createChromeLaunchUrlConfig', () => {
  it('builds a pwa-chrome launch config for the given URL', () => {
    const config = createChromeLaunchUrlConfig({
      url: 'http://localhost:3000',
      webRoot: '/repo/src'
    })
    expect(config.type).toBe('chrome')
    expect(config.request).toBe('launch')
    expect(config.adapterArgs).toMatchObject({
      type: 'pwa-chrome',
      request: 'launch',
      url: 'http://localhost:3000',
      webRoot: '/repo/src'
    })
  })
})
