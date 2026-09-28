import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import type {
  PersistedWslDaemonEndpoint,
  WslDaemonIncarnation
} from '../../shared/wsl-daemon-recovery'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { readWslDistributionIdentity } from './wsl-distribution-identity'

/** A missing socket never proves that the daemon's surviving terminals exited. */
export const WSL_DAEMON_INCARNATION_SCRIPT = String.raw`
const fs=require('node:fs');
const plan=JSON.parse(process.argv[1]);
if(String(process.getuid())!==plan.userId || process.env.HOME!==plan.home) throw Error('WSL daemon execution owner changed');
const prior=plan.incarnation;
if(!prior) throw Error('Retained guest owner has no process identity; recovery is unverifiable');
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
if(!boot) throw Error('Guest boot identity is unverifiable');
let exited=boot!==prior.bootId;
if(!exited) {
  let stat;
  try {stat=fs.readFileSync('/proc/'+prior.pid+'/stat','utf8');}
  catch(error) {
    if(error.code!=='ENOENT') throw error;
    try {process.kill(prior.pid,0);}
    catch(probe) {if(probe.code==='ESRCH') exited=true; else throw probe;}
    if(!exited) throw Error('Guest process identity is unverifiable');
  }
  if(stat!==undefined) {
    const close=stat.lastIndexOf(')');
    const ticks=close<0 ? undefined : stat.slice(close+2).split(/\s+/)[19];
    if(!ticks || !/^\d+$/.test(ticks)) throw Error('Guest process identity is unverifiable');
    exited=ticks!==prior.linuxStartTicks;
  }
}
if(!exited) throw Error('Retained guest daemon is still live; refusing replacement');
console.log('exited');
`

export async function proveWslDaemonIncarnationExited(
  endpoint: PersistedWslDaemonEndpoint,
  incarnation: WslDaemonIncarnation | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (!incarnation) {
    throw new Error('Retained guest owner has no process identity; recovery is unverifiable')
  }
  if ((await readWslDistributionIdentity(endpoint.distro)) !== endpoint.distributionId) {
    throw new Error('WSL distribution was replaced; terminal owner is unverifiable')
  }
  const runner = createRunningWslRuntimeRunner(endpoint.distro, signal, endpoint.userName)
  const result = await runner.run({
    program: endpoint.envBinary,
    args: [
      ...[
        'NODE_OPTIONS',
        'NODE_PATH',
        'BUN_OPTIONS',
        'BUN_INSPECT',
        'ELECTRON_RUN_AS_NODE'
      ].flatMap((key) => ['-u', key]),
      endpoint.runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      WSL_DAEMON_INCARNATION_SCRIPT,
      JSON.stringify({ userId: endpoint.userId, home: endpoint.home, incarnation })
    ],
    loginPath: 'none'
  })
  if (result !== 'exited') {
    throw new Error('Retained guest daemon death is unverifiable')
  }
}
