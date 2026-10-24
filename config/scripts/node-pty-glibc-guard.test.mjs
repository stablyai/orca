import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..', '..')
const patch = join(root, 'config/patches/node-pty@1.1.0.patch')
let dir
let shim

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    ...options
  })
}

function success(result) {
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

describe.skipIf(process.platform !== 'linux')('node-pty glibc build guards', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'node-pty-glibc-guard-'))
    mkdirSync(join(dir, 'src/unix'), { recursive: true })
    writeFileSync(
      join(dir, 'src/unix/pty.cc'),
      readFileSync(join(import.meta.dirname, '__fixtures__/node-pty-1.1.0-unix-pty.cc'))
    )
    success(
      run('git', ['apply', '--include=src/unix/pty.cc', '--include=scripts/orca-glibc.py', patch], {
        cwd: dir
      })
    )
    const source = readFileSync(join(dir, 'src/unix/pty.cc'), 'utf8')
    shim = source.slice(source.indexOf('/* Orca: glibc 2.32'), source.indexOf('/* Some platforms'))
    expect(shim).toContain('.symver openpty')
  })

  afterAll(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([false, true])('detects glibc=%s from target compiler headers and flags', (glibc) => {
    const include = join(dir, glibc ? 'glibc headers' : 'musl headers')
    mkdirSync(include)
    writeFileSync(join(include, 'features.h'), glibc ? '#define __GLIBC__ 2\n' : '')
    const result = run('python3', [join(dir, 'scripts/orca-glibc.py')], {
      env: {
        ...process.env,
        CXX: '/nonexistent/host-compiler',
        CXX_target: 'env c++',
        CPPFLAGS: `-I"${include}"`,
        CXXFLAGS: '-nostdinc'
      }
    })
    expect(success(result)).toBe(glibc ? '1' : '0')
  })

  it('fails configuration when the compiler probe fails instead of assuming musl', () => {
    const result = run('python3', [join(dir, 'scripts/orca-glibc.py')], {
      env: { ...process.env, CXX_target: 'c++', CPPFLAGS: '', CXXFLAGS: '--orca-invalid-option' }
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
  })

  it.each([
    ['x86_64', true, 'GLIBC_2.2.5'],
    ['aarch64', true, 'GLIBC_2.17'],
    ['x86_64', false, null],
    ['aarch64', false, null]
  ])('emits versioned symbols for %s only with glibc=%s', (arch, glibc, version) => {
    const macros = [
      '#undef __GLIBC__',
      '#undef __x86_64__',
      '#undef __aarch64__',
      `#define __${arch}__ 1`,
      ...(glibc ? ['#define __GLIBC__ 2'] : [])
    ].join('\n')
    const output = success(
      run('c++', ['-E', '-P', '-x', 'c++', '-'], { input: `${macros}\n${shim}` })
    )
    if (version) {
      for (const name of ['openpty', 'forkpty', 'pthread_sigmask', 'cfsetispeed', 'cfsetospeed']) {
        expect(output).toContain(`.symver ${name},${name}@`)
      }
      expect(output).toContain(version)
    } else {
      expect(output).not.toContain('.symver')
      expect(output).not.toContain('GLIBC_')
    }
  })
})
