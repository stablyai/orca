import type { ProviderProcessLaunch } from './provider-process-launch'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_SIGTERM_GRACE_MS
} from './provider-process-timing'

// Old leases name the relay parent; it owns a separate provider group and outlives its cleanup.
const LEGACY_SUPERVISOR = `
const {spawn}=require('node:child_process')
const [command,...args]=process.argv.slice(1)
const env={...process.env}
delete env.ELECTRON_RUN_AS_NODE
const child=spawn(command,args,{env,detached:true,stdio:['pipe','pipe','pipe']})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
let stopping=false
const exists=()=>{
  try { process.kill(-child.pid,0); return true }
  catch(error) { return error.code!=='ESRCH' }
}
const wait=async(ms)=>{
  const until=Date.now()+ms
  while(exists() && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,25))
  return !exists()
}
const signal=(value)=>{ try { process.kill(-child.pid,value) } catch {} }
const stop=async()=>{
  if(stopping) return
  stopping=true
  signal('SIGTERM')
  if(!await wait(${PROVIDER_SIGTERM_GRACE_MS})) {
    signal('SIGKILL')
    await wait(${PROVIDER_GROUP_REAP_TIMEOUT_MS})
  }
  process.exit(exists()?1:0)
}
process.on('SIGTERM',()=>void stop())
child.once('exit',()=>{ if(!stopping) void stop() })
`

export function supervisedPosixLaunch(
  launch: Pick<ProviderProcessLaunch, 'command' | 'args'>,
  env: NodeJS.ProcessEnv
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: process.execPath,
    args: ['-e', LEGACY_SUPERVISOR, '--', launch.command, ...launch.args],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
  }
}
