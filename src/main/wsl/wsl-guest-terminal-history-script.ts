/** Runs only under the captured guest user, before publishing the history environment. */
export const WSL_GUEST_HISTORY_PREPARE_SCRIPT = String.raw`
const fs = require('node:fs'), path = require('node:path');
const p = JSON.parse(process.argv[1]);
if (String(process.getuid()) !== p.owner.userId || process.env.HOME !== p.owner.home)
  throw new Error('WSL history owner changed');
const relative = path.relative(p.owner.home, p.directory);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('WSL history path escaped its owner');
let directory = p.owner.home;
for (const part of relative.split(path.sep)) {
  directory = path.join(directory, part);
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
    throw new Error('WSL history directory is not owned by its captured user');
}
const meta = path.join(directory, 'meta.json');
let existing;
try {
  const stat = fs.lstatSync(meta);
  if (stat.isFile() && stat.size <= 32768) existing = JSON.parse(fs.readFileSync(meta, 'utf8'));
} catch {}
if (!existing || (p.fishSession && (existing.fishSession !== p.fishSession || existing.fishHistoryDir !== p.fishHistoryDir))) {
  const temporary = path.join(directory, '.meta-' + process.pid + '-' + require('node:crypto').randomUUID());
  try {
    fs.writeFileSync(temporary, JSON.stringify({ worktreeId: p.worktreeId,
      createdAt: existing?.createdAt || new Date().toISOString(),
      ...(p.fishSession ? { fishSession: p.fishSession, fishHistoryDir: p.fishHistoryDir } : {})
    }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, meta);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
console.log('ready');
`
