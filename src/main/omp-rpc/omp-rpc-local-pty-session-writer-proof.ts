import type { IPtyProvider } from '../providers/pty-provider-contract'

type OmpPtySessionIdentity = { sessionFilePath: string } | null

/** Returns true when local PTY inventory proves another pane owns this OMP session. */
export async function hasOtherOmpLocalPtySessionWriter(args: {
  sessionFilePath: string
  excludedPtyId: string
  provider: Pick<IPtyProvider, 'listProcesses'>
  resolveSessionIdentity: (args: { ptyId: string; cwd: string }) => Promise<OmpPtySessionIdentity>
}): Promise<boolean> {
  let processes: Awaited<ReturnType<IPtyProvider['listProcesses']>>
  try {
    processes = await args.provider.listProcesses()
  } catch {
    return true
  }
  for (const process of processes) {
    if (process.id === args.excludedPtyId) {
      continue
    }
    try {
      const identity = await args.resolveSessionIdentity({ ptyId: process.id, cwd: process.cwd })
      if (identity?.sessionFilePath === args.sessionFilePath) {
        return true
      }
    } catch {
      return true
    }
  }
  return false
}
