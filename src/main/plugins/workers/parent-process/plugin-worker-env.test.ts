import { describe, expect, it } from 'vitest'
import { buildPluginWorkerEnv } from './plugin-worker-env'

describe('buildPluginWorkerEnv', () => {
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

  it('passes proxy routing in both cases, but never a proxy URL that carries credentials', () => {
    const env = buildPluginWorkerEnv(
      {
        ...sessionEnv,
        HTTPS_PROXY: 'http://proxy.example:3128',
        http_proxy: 'http://proxy.example:3128',
        ALL_PROXY: 'socks5://user:secret@proxy.example:1080',
        https_proxy: 'user:secret@proxy.example:3128',
        HTTP_PROXY: 'not a url',
        all_proxy: 'http://:secret@proxy.example:3128',
        NO_PROXY: 'localhost,.internal',
        no_proxy: 'localhost',
        NODE_USE_ENV_PROXY: '1'
      },
      'linux'
    )
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://proxy.example:3128',
      http_proxy: 'http://proxy.example:3128',
      NO_PROXY: 'localhost,.internal',
      no_proxy: 'localhost',
      NODE_USE_ENV_PROXY: '1'
    })
    for (const key of ['ALL_PROXY', 'https_proxy', 'HTTP_PROXY', 'all_proxy']) {
      expect(env).not.toHaveProperty(key)
    }
  })

  it('reads Windows variables case-insensitively and restores SystemRoot casing', () => {
    expect(
      buildPluginWorkerEnv(
        {
          Path: 'C:\\Windows',
          systemroot: 'C:\\Windows',
          SSH_AUTH_SOCK: '\\\\.\\pipe\\agent',
          https_proxy: 'http://proxy.example:3128'
        },
        'win32'
      )
    ).toEqual({
      PATH: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      SSH_AUTH_SOCK: '\\\\.\\pipe\\agent',
      HTTPS_PROXY: 'http://proxy.example:3128',
      GIT_TERMINAL_PROMPT: '0',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })
})
