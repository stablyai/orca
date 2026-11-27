/** Tells a paired host which Orca account this desktop is signed in to and this computer's name, so
 *  its typed messages name that person and computer. A plain claim; the host keeps it per socket. */
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { DECLARE_ORCA_ACCOUNT_METHOD } from '../../../../shared/remote-runtime/pairing/paired-desktop-account-contract'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { pairedDesktopInstanceId } from './paired-desktop-instance-id'
import { sanitizeDeviceLabel } from '../../../../shared/remote-runtime/pairing/device-key-proof'
import {
  connectorAccount,
  connectorAccountName
} from '../../../connector-cloud/connector-token-mint'

const DECLARE_TIMEOUT_MS = 10_000

// The runtime owns the machine name (setting, then detected); it starts after this module loads.
let readComputerName: () => string = () => ''

export function providePairedDesktopComputerName(read: () => string): void {
  readComputerName = read
}

type ControlRequest = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

export function declarePairedDesktopAccount(request: ControlRequest): void {
  const userData = getAppEnvironment().getPath('userData')
  let account: DeclaredAccount = null
  try {
    const id = connectorAccount(userData)
    const computer = sanitizeDeviceLabel(readComputerName(), '')
    account = id
      ? {
          id,
          name: connectorAccountName(userData).slice(0, 80),
          ...(computer ? { computer } : {})
        }
      : null
  } catch {
    // No readable profile: claim no account.
  }
  void pairedDesktopInstanceId(userData)
    .then((clientInstanceId) => sendPairedDesktopAccount(request, account, clientInstanceId))
    .catch(() => {
      // A socket that dropped before the answer declares again on its next ready.
    })
}

type DeclaredAccount = { id: string; name: string; computer?: string } | null

/** An older host lacks the method and names this desktop's messages by the computer. One from
 *  before the computer name and installation id refuses the whole claim, keeping the last account;
 *  resend it without them. */
export async function sendPairedDesktopAccount(
  request: ControlRequest,
  account: DeclaredAccount,
  clientInstanceId: string
): Promise<void> {
  const answer = await request(
    DECLARE_ORCA_ACCOUNT_METHOD,
    { account, clientInstanceId },
    DECLARE_TIMEOUT_MS
  )
  if (!answer.ok && answer.error.code === 'invalid_argument') {
    const legacy = account ? { id: account.id, name: account.name } : null
    await request(DECLARE_ORCA_ACCOUNT_METHOD, { account: legacy }, DECLARE_TIMEOUT_MS)
  }
}
