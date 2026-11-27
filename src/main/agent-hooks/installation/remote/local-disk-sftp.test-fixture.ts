import * as fs from 'node:fs'
import type { SFTPWrapper } from 'ssh2'

type NodeCallback = (error: NodeJS.ErrnoException | null, value?: unknown) => void

// Serve SFTP from local disk; ssh2 reports a missing file as status code 2.
export function localDiskSftp(options?: { onBeforeWrite?: (path: string) => void }): SFTPWrapper {
  const methods = [
    'readFile',
    'readdir',
    'writeFile',
    'stat',
    'rename',
    'unlink',
    'chmod',
    'mkdir'
  ] as const
  const forward =
    (name: (typeof methods)[number], call: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      if (name === 'writeFile' && typeof args[0] === 'string') {
        options?.onBeforeWrite?.(args[0])
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2 and node:fs both pass the callback last.
      const callback = args.pop() as NodeCallback
      call(...args, (error: NodeJS.ErrnoException | null, value?: unknown) =>
        callback(error?.code === 'ENOENT' ? Object.assign(error, { code: 2 }) : error, value)
      )
    }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer only calls these callback methods.
  return Object.fromEntries(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each node:fs method here takes its callback last, like ssh2's.
    methods.map((name) => [name, forward(name, fs[name] as (...args: unknown[]) => void)])
  ) as unknown as SFTPWrapper
}
