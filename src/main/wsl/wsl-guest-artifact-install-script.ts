/** Runs under the already verified guest runtime; argv carries data without shell interpolation. */
export const WSL_GUEST_ARTIFACT_INSTALL_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const plan = JSON.parse(process.argv[1]);
if (plan.userId !== undefined && (String(process.getuid()) !== plan.userId || process.env.HOME !== plan.home)) throw Error('WSL artifact execution owner changed');
function privateDirectory(directory) {
  if (!path.isAbsolute(directory) || path.resolve(directory)!==directory) throw Error('Invalid guest terminal directory');
  let ancestor=path.parse(directory).root;
  for(const segment of directory.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor=path.join(ancestor,segment);
    try {fs.mkdirSync(ancestor,{mode:0o700});} catch(error) {if(error.code!=='EEXIST')throw error;}
    const checked=fs.lstatSync(ancestor);
    if(!checked.isDirectory() || checked.isSymbolicLink() || ![0,process.getuid()].includes(checked.uid)) throw Error('Unowned guest terminal ancestor');
    if((checked.mode & 0o022) && !(checked.uid===0 && (checked.mode & 0o1000))) throw Error('Writable guest terminal ancestor');
  }
  const stat=fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw Error('Unowned guest terminal directory');
  fs.chmodSync(directory,0o700);
}
function matches(directory) {
  try {
    const directoryStat=fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.uid!==process.getuid()) return false;
    return plan.files.every(file=> {
      const entry=path.join(directory,file.name);
      const stat=fs.lstatSync(entry);
      return stat.isFile() && !stat.isSymbolicLink() && (!file.executable || (stat.mode & 0o100)!==0) && createHash('sha256').update(fs.readFileSync(entry)).digest('hex')===file.sha256;
    });
  } catch { return false; }
}
privateDirectory(plan.artifactRoot);
privateDirectory(plan.ownerDirectory);
if (fs.existsSync(plan.directory)) {
  if (!matches(plan.directory)) throw Error('Existing guest terminal artifacts changed; refusing to replace a possible live owner');
} else {
  const stage=path.join(plan.artifactRoot,'.stage-'+randomUUID());
  privateDirectory(stage);
  try {
    for (const file of plan.files) {
      const destination=path.join(stage,file.name);
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      fs.copyFileSync(file.source || path.join(plan.source,file.sourceName || file.name),destination,fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination,file.executable ? 0o700 : 0o600);
      const fd=fs.openSync(destination,'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (!matches(stage)) throw Error('Guest terminal artifact checksum mismatch');
    try { fs.renameSync(stage,plan.directory); }
    catch(error) { if (!['EEXIST','ENOTEMPTY'].includes(error.code) || !matches(plan.directory)) throw error; }
    const fd=fs.openSync(plan.artifactRoot,'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } finally { fs.rmSync(stage,{recursive:true,force:true}); }
}
console.log('ready');
`
