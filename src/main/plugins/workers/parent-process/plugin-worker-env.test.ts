import { afterEach, describe, expect, it } from 'vitest'
import { setNetworkProxySettingsSource } from '../../../browser/network/execution-routes/browser-network-proxy-settings-source'
import { buildPluginWorkerEnv } from './plugin-worker-env'

describe('buildPluginWorkerEnv', () => {
  afterEach(() => {
    setNetworkProxySettingsSource(null)
  })

  const sessionEnv = {
    PATH: '/usr/bin',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GITHUB_TOKEN: 'secret'
  }

  it('passes session socket pointers so credential helpers and ssh-agent work', () => {
    expect(buildPluginWorkerEnv(sessionEnv, 'linux')).toEqual({
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      GIT_TERMINAL_PROMPT: '0',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it("drops Chromium's disabled: bus marker so GLib falls back to $XDG_RUNTIME_DIR/bus", () => {
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
      'linux'
    )
    expect(env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS')
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
  })

  it('drops variables that load code into the worker or its git children', () => {
    const env = buildPluginWorkerEnv(
      {
        ...sessionEnv,
        NODE_OPTIONS: '--require /tmp/x.js',
        LD_PRELOAD: '/tmp/x.so',
        DYLD_INSERT_LIBRARIES: '/tmp/x.dylib',
        GIT_ASKPASS: '/tmp/askpass',
        GIT_TERMINAL_PROMPT: '1'
      },
      'linux'
    )
    expect(Object.keys(env).sort()).toEqual([
      'DBUS_SESSION_BUS_ADDRESS',
      'ELECTRON_RUN_AS_NODE',
      'GIT_TERMINAL_PROMPT',
      'PATH',
      'SSH_AUTH_SOCK',
      'XDG_RUNTIME_DIR'
    ])
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('reads Windows variables case-insensitively and restores SystemRoot casing', () => {
    expect(
      buildPluginWorkerEnv(
        { Path: 'C:\\Windows', systemroot: 'C:\\Windows', SSH_AUTH_SOCK: '\\\\.\\pipe\\agent' },
        'win32'
      )
    ).toEqual({
      PATH: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      SSH_AUTH_SOCK: '\\\\.\\pipe\\agent',
      GIT_TERMINAL_PROMPT: '0',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('passes the proxy Orca was started with, in every spelling it inherited', () => {
    const env = buildPluginWorkerEnv(
      {
        ...sessionEnv,
        HTTPS_PROXY: 'http://proxy.example:3128',
        NO_PROXY: 'localhost',
        NODE_USE_ENV_PROXY: '1'
      },
      'linux'
    )
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:3128')
    expect(env.NO_PROXY).toBe('localhost')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  it('keeps a lowercase proxy name as the platform spelled it', () => {
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, https_proxy: 'http://proxy.example:3128', no_proxy: '.internal' },
      'linux'
    )
    expect(env.https_proxy).toBe('http://proxy.example:3128')
    expect(env.no_proxy).toBe('.internal')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
  })

  it('falls back to the proxy configured in Settings when none was inherited', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'socks5://proxy.example:1080',
      httpProxyBypassRules: 'localhost; 127.0.0.1'
    }))
    const env = buildPluginWorkerEnv(sessionEnv, 'linux')
    expect(env.HTTPS_PROXY).toBe('socks5://proxy.example:1080')
    expect(env.https_proxy).toBe('socks5://proxy.example:1080')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1')
  })

  it('lets an inherited proxy win over the one configured in Settings', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, HTTPS_PROXY: 'http://inherited.example:3128', NO_PROXY: '*' },
      'linux'
    )
    expect(env.HTTPS_PROXY).toBe('http://inherited.example:3128')
    expect(env.NO_PROXY).toBe('*')
  })

  it('does not add a Settings proxy beside an inherited one spelled differently', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: 'corp.example'
    }))
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, https_proxy: 'http://inherited.example:3128' },
      'linux'
    )
    expect(env.https_proxy).toBe('http://inherited.example:3128')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('NO_PROXY')
  })

  it('keeps a proxy login out of the worker while passing the route', () => {
    const env = buildPluginWorkerEnv(
      {
        ...sessionEnv,
        HTTPS_PROXY: 'http://user:secret@proxy.example:3128',
        ALL_PROXY: 'socks5://user:secret@proxy.example:1080',
        NO_PROXY: 'localhost'
      },
      'linux'
    )
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('ALL_PROXY')
    expect(env.NO_PROXY).toBe('localhost')
    for (const value of Object.values(env)) {
      expect(value).not.toContain('secret')
    }
  })

  it('keeps a proxy login out of the worker when the proxy comes from Settings', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://user:secret@settings-proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv(sessionEnv, 'linux')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('NO_PROXY')
    for (const value of Object.values(env)) {
      expect(value).not.toContain('secret')
    }
  })

  it('does not swap in the Settings proxy for an inherited one held back for its login', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: 'corp.example'
    }))
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, HTTPS_PROXY: 'http://user:secret@inherited.example:3128' },
      'linux'
    )
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('https_proxy')
    expect(env).not.toHaveProperty('NO_PROXY')
  })

  it('keeps an inherited bypass list when the bypass list came from Settings', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: 'corp.example'
    }))
    const env = buildPluginWorkerEnv({ ...sessionEnv, NO_PROXY: 'localhost,.internal' }, 'linux')
    expect(env.NO_PROXY).toBe('localhost,.internal')
    expect(env.HTTPS_PROXY).toBe('http://settings-proxy.example:8080')
    expect(env).not.toHaveProperty('no_proxy')
  })

  it('turns on environment-proxy support for a proxy that only Settings knows about', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv({ ...sessionEnv, NODE_USE_ENV_PROXY: undefined }, 'linux')
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
  })

  it('treats an empty inherited proxy as absent, not as a route', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv({ ...sessionEnv, HTTPS_PROXY: '   ' }, 'linux')
    expect(env.HTTPS_PROXY).toBe('http://settings-proxy.example:8080')
  })

  it('keeps a bypass list whose entries carry ports', () => {
    const env = buildPluginWorkerEnv(
      { ...sessionEnv, NO_PROXY: 'localhost:8080,.internal:443' },
      'linux'
    )
    expect(env.NO_PROXY).toBe('localhost:8080,.internal:443')
  })

  it('gives a Settings SOCKS proxy the undici name that Node reads', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'socks5://proxy.example:1080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv(sessionEnv, 'linux')
    expect(env.UNDICI_HTTPS_PROXY).toBe('socks5://proxy.example:1080')
  })

  it('does not add an undici name for an HTTP proxy', () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://settings-proxy.example:8080',
      httpProxyBypassRules: ''
    }))
    const env = buildPluginWorkerEnv(sessionEnv, 'linux')
    expect(env).not.toHaveProperty('UNDICI_HTTPS_PROXY')
  })
})
