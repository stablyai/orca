import { HOOK_REQUEST_MAX_BYTES } from '../../../shared/agent-hook-listener/request-body'
import {
  POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS,
  POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS
} from '../../agent-hooks/installation/scripts/hook-stdin-contract'

// Claude abandons a slow statusline refresh with the pipe still open; a bounded read exits instead of orphaning the wrapper.
// Writes argv[2] only when stdin completes; a timed-out refresh leaves no payload, so the caller skips posting it.
export const WINDOWS_CLAUDE_STATUSLINE_STDIN_READER_SCRIPT = String.raw`
const { StringDecoder } = require('node:string_decoder');
const outPath = process.argv[2];
const maxBytes = ${HOOK_REQUEST_MAX_BYTES};
if (!outPath) process.exit(0);
const decoder = new StringDecoder('utf8');
let payload = '';
let finished = false;
let byteLength = 0;
let idleTimer;
const absoluteTimer = setTimeout(finish, 7000);
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  clearTimeout(absoluteTimer);
  process.stdin.pause();
  payload += decoder.end();
  try { require('node:fs').writeFileSync(outPath, payload); } catch {}
  process.exit(0);
}
function resetIdle(timeout) { clearTimeout(idleTimer); idleTimer = setTimeout(finish, timeout); }
resetIdle(${POSIX_HOOK_JSON_STDIN_FIRST_BYTE_TIMEOUT_SECONDS * 1000});
process.stdin.on('data', chunk => {
  if (finished) return;
  byteLength += chunk.length;
  if (byteLength > maxBytes) finish();
  payload += decoder.write(chunk);
  resetIdle(${POSIX_HOOK_JSON_STDIN_IDLE_TIMEOUT_SECONDS * 1000});
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
`
