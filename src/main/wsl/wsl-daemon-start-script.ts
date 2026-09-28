import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'

/** Only confirmed absence permits startup; daemon endpoint arbitration protects racing launches. */
export const WSL_DAEMON_START_SCRIPT = String.raw`
const net=require('node:net');
const plan=JSON.parse(process.argv[1]);
if (String(process.getuid()) !== plan.userId || process.env.HOME !== plan.home) throw Error('WSL daemon execution owner changed');
function contact() {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(plan.socket);
    socket.setTimeout(2000);
    socket.once('connect',()=>{socket.destroy();resolve('live');});
    socket.once('timeout',()=>{socket.destroy();reject(Error('Guest owner contact is unverifiable'));});
    socket.once('error',error=>{
      if (['ENOENT','ECONNREFUSED'].includes(error.code)) resolve('absent');
      else reject(Error('Guest owner contact is unverifiable: '+error.code));
    });
  });
}
(async()=>{
  if(await contact()==='live'){console.log('existing');return;}
  const fs=require('node:fs');
  const {createHash}=require('node:crypto');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const readArtifact=file=>{
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid() || (stat.mode & 0o022)) throw Error('Guest daemon artifact ownership changed');
    return fs.readFileSync(file);
  };
  const artifactId=hash(JSON.stringify({runtime:hash(readArtifact(plan.runtime)),files:[{name:'daemon-entry.js',sha256:hash(readArtifact(plan.entry))}]}));
  if(artifactId!==plan.serverBuildId) throw Error('Retained guest daemon artifacts changed; refusing restart');
  const env={...process.env,HOME:plan.home,PATH:plan.path??process.env.PATH,ORCA_BACKGROUND_LAUNCH:'1'};
  for(const key of ['NODE_OPTIONS','NODE_PATH','BUN_OPTIONS','BUN_INSPECT','ELECTRON_RUN_AS_NODE']) delete env[key];
  const child=Bun.spawn([plan.runtime,...${JSON.stringify(bunOwnedRuntimeArgs('linux'))},plan.entry,'--socket',plan.socket,'--token',plan.tokenPath],{
    detached:true,stdin:'ignore',stdout:'ignore',stderr:'ignore',cwd:plan.home,env
  });
  child.unref();
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    if(await contact()==='live'){console.log('started');return;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('Guest daemon did not publish its endpoint');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
`
