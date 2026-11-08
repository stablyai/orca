export interface LaunchRoute { page: string; params: Record<string, string>; }

/** Parse only app routes; never treat arbitrary launch input as a WebView URL. */
export function parseLaunchRoute(uri: string): LaunchRoute | null {
  if (uri.length > 131072 || !uri.startsWith('orca://')) { return null; }
  if (uri.startsWith('orca://pair?')) {
    return { page: 'pages/PairScan', params: { 'pairingCode': uri } };
  }
  if (!uri.startsWith('orca://session?')) { return null; }
  let fields: Record<string, string> = {};
  let parts = uri.substring('orca://session?'.length).split('&');
  try {
    for (let i = 0; i < parts.length; i++) {
      let separator = parts[i].indexOf('=');
      if (separator > 0) { fields[parts[i].substring(0, separator)] = decodeURIComponent(parts[i].substring(separator + 1)); }
    }
  } catch (e) { return null; }
  let host = fields['hostId']; let worktree = fields['worktreeId'];
  if (!host || !/^[a-f0-9]{32}$/.test(host) || !worktree || worktree.length > 512) { return null; }
  return { page: 'pages/ShellScreen', params: { 'hostId': host, 'route': `/h/${host}/session/${encodeURIComponent(worktree)}` } };
}
