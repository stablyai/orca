import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import {
  createNotebookVenv,
  findWorkspaceInterpreters,
  installIpykernel,
  listPythonEnvironments
} from './python-environments'

function existing(...paths: string[]): (path: string) => boolean {
  return (path) => paths.includes(path)
}

describe('findWorkspaceInterpreters', () => {
  it('walks from the notebook folder to the workspace root, nearest env first', () => {
    const exists = existing(
      join('/repo/.venv/bin/python'),
      join('/repo/analysis/.conda/bin/python'),
      join('/.venv/bin/python')
    )
    expect(
      findWorkspaceInterpreters('/repo/analysis/week1/nb.ipynb', '/repo', 'darwin', exists)
    ).toEqual([join('/repo/analysis/.conda/bin/python'), join('/repo/.venv/bin/python')])
  })

  it('only looks beside the notebook when it is outside the workspace or there is none', () => {
    const exists = existing(join('/elsewhere/.venv/bin/python'), join('/.venv/bin/python'))
    expect(findWorkspaceInterpreters('/elsewhere/nb.ipynb', '/repo', 'linux', exists)).toEqual([
      join('/elsewhere/.venv/bin/python')
    ])
    expect(findWorkspaceInterpreters('/elsewhere/nb.ipynb', null, 'linux', exists)).toEqual([
      join('/elsewhere/.venv/bin/python')
    ])
  })

  it('uses Scripts\\\\python.exe for venvs and the env root for conda on Windows', () => {
    const exists = existing(join('/repo/.venv/Scripts/python.exe'), join('/repo/.conda/python.exe'))
    expect(findWorkspaceInterpreters('/repo/nb.ipynb', '/repo', 'win32', exists)).toEqual([
      join('/repo/.venv/Scripts/python.exe'),
      join('/repo/.conda/python.exe')
    ])
  })
})

describe('listPythonEnvironments', () => {
  let root = ''
  const windows = process.platform === 'win32'
  const venvPython = (): string =>
    join(root, '.venv', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  const condaPython = (): string =>
    join(root, 'nb', '.conda', ...(windows ? ['python.exe'] : ['bin', 'python']))
  const programs = (): string[] => runProcessMock.mock.calls.map(([spec]) => spec.program)

  beforeEach(() => {
    runProcessMock.mockReset()
    runProcessMock.mockImplementation(async ({ program }: { program: string }) => ({
      code: 0,
      stdout: `${program}\n3.13.0\n`,
      stderr: ''
    }))
    root = mkdtempSync(join(tmpdir(), 'orca-pyenvs-'))
    for (const interpreter of [venvPython(), condaPython()]) {
      mkdirSync(dirname(interpreter), { recursive: true })
      writeFileSync(interpreter, '')
    }
    writeFileSync(
      join(root, '.venv', 'pyvenv.cfg'),
      'home = /usr/bin\nversion_info = 3.12.1.final.0\n'
    )
    const condaMeta = join(root, 'nb', '.conda', 'conda-meta')
    mkdirSync(condaMeta)
    writeFileSync(join(condaMeta, 'python-dateutil-2.9.0-pyhd8ed1ab_0.json'), '{}')
    writeFileSync(join(condaMeta, 'python-3.11.9-h8d4a6d2_0.json'), '{}')
    return () => rmSync(root, { recursive: true, force: true })
  })

  it('lists workspace envs from disk without running them before trust', async () => {
    const found = await listPythonEnvironments(join(root, 'nb', 'a.ipynb'), root, {
      runWorkspaceInterpreters: false
    })
    expect(programs()).not.toContain(venvPython())
    expect(programs()).not.toContain(condaPython())
    expect(programs().length).toBeGreaterThan(0)
    expect(found.workspace).toEqual([
      { path: condaPython(), name: '.conda', version: '3.11.9' },
      { path: venvPython(), name: '.venv', version: '3.12.1' }
    ])
  })

  it('reads the stdlib venv version key and omits a version it cannot find', async () => {
    writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.10.4\n')
    const found = await listPythonEnvironments(join(root, 'a.ipynb'), root, {
      runWorkspaceInterpreters: false
    })
    expect(found.workspace).toEqual([{ path: venvPython(), name: '.venv', version: '3.10.4' }])

    writeFileSync(join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n')
    const unversioned = await listPythonEnvironments(join(root, 'a.ipynb'), root, {
      runWorkspaceInterpreters: false
    })
    expect(unversioned.workspace).toEqual([{ path: venvPython(), name: '.venv' }])
  })

  it('probes workspace envs once the notebook is trusted, dropping ones that fail', async () => {
    runProcessMock.mockImplementation(async ({ program }: { program: string }) =>
      program === condaPython()
        ? { code: 1, stdout: '', stderr: 'broken' }
        : { code: 0, stdout: `${program}\n3.13.0\n`, stderr: '' }
    )
    const found = await listPythonEnvironments(join(root, 'nb', 'a.ipynb'), root, {
      runWorkspaceInterpreters: true
    })
    expect(programs()).toContain(venvPython())
    expect(programs()).toContain(condaPython())
    expect(found.workspace).toEqual([{ path: venvPython(), name: '.venv', version: '3.13.0' }])
  })
})

describe('installIpykernel', () => {
  beforeEach(() => runProcessMock.mockReset())
  const result = (code: number | null, stderr = '', extra = {}) => ({
    code,
    stderr,
    stdout: '',
    ...extra
  })

  it('bootstraps pip with ensurepip when the env has none, then installs and imports', async () => {
    runProcessMock
      .mockResolvedValueOnce(result(1, '/venv/bin/python: No module named pip'))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(0))
    await expect(installIpykernel('/venv/bin/python')).resolves.toEqual({ ok: true, detail: '' })
    expect(runProcessMock.mock.calls.map(([spec]) => spec.args)).toEqual([
      ['-m', 'pip', 'install', '-U', 'ipykernel'],
      ['-m', 'ensurepip'],
      ['-m', 'pip', 'install', '-U', 'ipykernel'],
      ['-c', 'import ipykernel, jupyter_client.manager']
    ])
  })

  it('fails when pip succeeds but ipykernel still cannot be imported', async () => {
    runProcessMock
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1, 'ImportError: libzmq.so.5'))
    await expect(installIpykernel('/venv/bin/python')).resolves.toEqual({
      ok: false,
      detail: 'ImportError: libzmq.so.5'
    })
  })

  it('explains a failure that printed nothing', async () => {
    runProcessMock.mockResolvedValueOnce(result(null, '', { timedOut: true }))
    await expect(installIpykernel('/venv/bin/python')).resolves.toEqual({
      ok: false,
      detail: 'Timed out.'
    })
  })
})

describe('createNotebookVenv', () => {
  beforeEach(() => runProcessMock.mockReset())
  const interpreterIn = (venv: string): string =>
    process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })

  it('creates .venv in the parent, installs ipykernel into it, and describes it', async () => {
    const venv = join('/repo', '.venv')
    const venvPython = interpreterIn(venv)
    runProcessMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(`${venvPython}\n3.14.0\n`))
    await expect(createNotebookVenv('/usr/bin/python3', '/repo')).resolves.toMatchObject({
      ok: true,
      environment: { path: venvPython, version: '3.14.0' }
    })
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({
      program: '/usr/bin/python3',
      args: ['-m', 'venv', venv]
    })
  })

  it('reuses an existing .venv rather than re-running venv over it', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'orca-venv-'))
    try {
      const venvPython = interpreterIn(join(parent, '.venv'))
      mkdirSync(dirname(venvPython), { recursive: true })
      writeFileSync(venvPython, '')
      runProcessMock
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok(`${venvPython}\n3.12.1\n`))
      await expect(createNotebookVenv('/usr/bin/python3', parent)).resolves.toMatchObject({
        ok: true
      })
      expect(runProcessMock.mock.calls.map(([spec]) => spec.program)).not.toContain(
        '/usr/bin/python3'
      )
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('reports why venv creation failed', async () => {
    runProcessMock.mockResolvedValueOnce({
      code: 1,
      stdout: '',
      stderr:
        'The virtual environment was not created successfully because ensurepip is not available.'
    })
    await expect(createNotebookVenv('/usr/bin/python3', '/repo')).resolves.toEqual({
      ok: false,
      detail: expect.stringContaining('ensurepip is not available')
    })
  })
})
