import { afterAll, beforeAll, expect, it, vi } from 'vitest'

type ProcessSpec = { program: string; args: string[] }
const { runProcess } = vi.hoisted(() => ({
  runProcess: vi.fn<(spec: ProcessSpec) => Promise<unknown>>()
}))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../linux-secret-service/session-bus-environment', () => ({
  secretServiceProcessEnvironment: async () => ({})
}))

import { readAntigravityLinuxCredential } from './native-linux-credentials'

const platform = process.platform
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'linux' }))
afterAll(() => Object.defineProperty(process, 'platform', { value: platform }))

const exited = (code: number, stdout: string, stderr = '') => ({
  code,
  stdout,
  stderr,
  signal: null,
  timedOut: false,
  outputTruncated: false
})

function mockKeyring(
  lookup: ReturnType<typeof exited>,
  search: ReturnType<typeof exited> = exited(1, '')
): void {
  runProcess.mockReset()
  runProcess.mockImplementation(async ({ program, args }) => {
    if (program === 'gdbus') {
      return exited(
        0,
        args.includes('Locked')
          ? '(<false>,)\n'
          : "(<[objectpath '/org/freedesktop/secrets/collection/kdewallet']>,)\n"
      )
    }
    return args[0] === 'lookup' ? lookup : search
  })
}

// ksecretd keeps go-keyring's "text/plain; charset=utf-8", which libsecret < 0.21.8 rejects.
function mockKdeKeyring(search: ReturnType<typeof exited>): void {
  mockKeyring(exited(1, '', 'secret-tool: secret does not contain a textual password\n'), search)
}

function secretToolCommands(): string[] {
  return runProcess.mock.calls
    .map(([spec]) => spec)
    .filter((spec) => spec.program === 'secret-tool')
    .map((spec) => spec.args[0])
}

it('reads with a single lookup when secret-tool accepts the content type', async () => {
  mockKeyring(exited(0, '{"token":{"access_token":"secret-access"}}'))
  await expect(readAntigravityLinuxCredential()).resolves.toMatchObject({
    accessToken: 'secret-access'
  })
  expect(secretToolCommands()).toEqual(['lookup'])
})

it('does not fall back to search on other lookup errors', async () => {
  mockKeyring(exited(1, '', 'secret-tool: The name is not activatable\n'))
  await expect(readAntigravityLinuxCredential()).rejects.toThrow(
    'The Antigravity Linux keyring could not be read.'
  )
  expect(secretToolCommands()).toEqual(['lookup'])
})

it('reads a KDE login that secret-tool lookup rejects for its content type', async () => {
  // search prints the raw secret, so a pretty-printed login spans lines.
  const contents = '{\n  "token": {\n    "access_token": "secret-access"\n  }\n}'
  mockKdeKeyring(
    exited(
      0,
      `[/1]\nlabel = Password for 'antigravity' on 'gemini'\nsecret = ${contents}\ncreated = 2026-11-20 10:00:00\nmodified = 2026-11-20 10:00:00\n`
    )
  )
  await expect(readAntigravityLinuxCredential()).resolves.toMatchObject({
    contents,
    accessToken: 'secret-access'
  })
})

it('fails generically when search prints no secret line', async () => {
  // search still exits 0 when the item's GetSecret call fails; it only omits the secret line.
  mockKdeKeyring(
    exited(
      0,
      "[/1]\nlabel = Password for 'antigravity' on 'gemini'\ncreated = 2026-11-20 10:00:00\nmodified = 2026-11-20 10:00:00\nattribute.service = gemini\n",
      'secret-tool: Cannot get secret of a locked object: secret-access\n'
    )
  )
  const error = await readAntigravityLinuxCredential().catch((reason: unknown) => reason)
  expect(error).toEqual(new Error('The Antigravity Linux keyring could not be read.'))
  expect(error).not.toHaveProperty('cause')
})
