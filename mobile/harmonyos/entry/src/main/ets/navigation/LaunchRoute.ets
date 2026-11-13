import { desktopPath, shellRouterParams } from './ShellRoute';

export interface LaunchRoute { page: string; params: Record<string, string>; }

function readFields(query: string): Record<string, string> | null {
  let fields: Record<string, string> = {};
  try {
    for (let part of query.split('&')) {
      let separator = part.indexOf('=');
      if (separator < 1) { continue; }
      let key = decodeURIComponent(part.substring(0, separator));
      if (Object.keys(fields).includes(key)) { return null; }
      fields[key] = decodeURIComponent(part.substring(separator + 1));
    }
  } catch (e) { return null; }
  return fields;
}

function isRouteValue(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function runtimeHost(value: string): string | null {
  let normalized = value.trim();
  if (!normalized.startsWith('runtime:') || !isRouteValue(normalized, 512)) { return null; }
  let encoded = normalized.substring('runtime:'.length);
  if (!encoded || encoded.includes('|')) { return null; }
  try { return decodeURIComponent(encoded).length > 0 ? normalized : null; } catch (e) { return null; }
}

/** Keep route identities encoded once; query values travel separately to bridge init. */
export function parseLaunchRoute(uri: string): LaunchRoute | null {
  if (uri.length > 132096) { return null; }
  if (/^orca:\/\/pair\/?(?:[?#]|$)/i.test(uri)) {
    return { page: 'pages/PairScan', params: { 'pairingCode': uri } };
  }
  if (!uri.startsWith('orca://session?')) { return null; }
  let fields = readFields(uri.substring('orca://session?'.length));
  if (fields === null) { return null; }
  let host = fields['hostId']; let worktree = fields['worktreeId'];
  if (!host || !/^[a-f0-9]{32}$/.test(host)) { return null; }
  let pathname = desktopPath(host);
  let params: Record<string, string> = {};
  if (worktree !== undefined) {
    if (!isRouteValue(worktree, 512)) { return null; }
    pathname += `/session/${encodeURIComponent(worktree)}`;
    let pane = fields['paneKey'];
    if (pane !== undefined && isRouteValue(pane, 2048)) { params['paneKey'] = pane; }
    let executionHost = runtimeHost(fields['executionHost'] ?? '');
    if (executionHost !== null) { params['executionHost'] = executionHost; }
  }
  return { page: 'pages/ShellScreen', params: shellRouterParams({ hostId: host, pathname: pathname, params: params }, true) };
}
