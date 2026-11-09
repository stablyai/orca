import { url } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { bundleManager } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import upstream from '../vendor/connection-diagnostics.js';
import { utf8Encode } from '../transport/crypto/Bytes';
import type { ConnectionLogEntry } from './ConnectionLogStore';

const model: ESObject = upstream;
model.installRuntime((value: string): url.URL => new url.URL(value), utf8Encode);

export interface ConnectionEvidence {
  endpoint: string;
  state: string;
  activePath?: string;
  pendingPath?: string;
  entries: ConnectionLogEntry[];
}

export interface ConnectionDiagnosis {
  likelyCause: string;
  nextStep: string;
  reportability: string;
}

export interface ConnectionReport {
  endpoint: string;
  state: string;
  activePath?: string;
  pendingPath?: string;
  entries: ConnectionLogEntry[];
  hostName: string;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  desktopAppVersion: string | null;
  appVersion: string;
  platform: string;
  bridgeProtocolVersion: number;
}

export function redactDiagnosticText(value: string): string {
  let redacted = value.replace(/orca:\/\/pair\/?[?#][^\s"'<>]+/gi, '[redacted pairing link]');
  return model.redactConnectionLogText(redacted) as string;
}

export function endpointLabel(endpoint: string): string { return model.formatEndpoint(endpoint) as string; }
export interface DesktopEndpointEdit { kind: string; endpoint?: string; error?: string; }

export function displayHostEndpoint(endpoint: string): string { return model.displayHostEndpoint(endpoint) as string; }
export function resolveDesktopEndpoint(stored: string, input: string): DesktopEndpointEdit {
  return model.resolveHostEndpointEdit(stored, input) as DesktopEndpointEdit;
}
export function directPath(endpoint: string): string { return model.isTailscaleEndpoint(endpoint) ? 'tailscale' : 'lan'; }

export function diagnoseConnection(evidence: ConnectionEvidence): ConnectionDiagnosis {
  return model.diagnoseConnection(evidence) as ConnectionDiagnosis;
}

export function reportableIncident(evidence: ConnectionEvidence): string | null {
  return evidence.state !== 'connected' ? model.getReportableConnectionIncidentId(evidence) as string | null : null;
}

export function appVersion(): string {
  try { return bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION).versionName; }
  catch (e) { return 'unknown'; }
}

export function platformVersion(): string { return `harmonyos ${deviceInfo.osFullName}`.trim(); }

export function connectionReport(report: ConnectionReport | null, entries: ConnectionLogEntry[]): string {
  if (report) { return model.buildConnectionDiagnosticsReport(report) as string; }
  let history = model.formatConnectionLogHistory(entries) as string;
  return `Orca Mobile connection diagnostics\nApp: Orca Mobile ${appVersion()} · ${platformVersion()}\nNo paired hosts.\n\n${history}`;
}

interface FeedbackPayload {
  feedback: string;
  submissionType: string;
  githubLogin: string | null;
  githubEmail: string | null;
  appVersion: string;
  platform: string;
  osRelease: string;
  arch: string;
}

export async function sendConnectionReport(report: string, version: string, platform: string): Promise<boolean> {
  let payload: FeedbackPayload = {
    feedback: model.boundConnectionDiagnosticsReport(report) as string, submissionType: 'connection_diagnostics',
    githubLogin: null, githubEmail: null, appVersion: version, platform: `mobile-${platform}`, osRelease: 'unknown', arch: 'unknown'
  };
  let request = http.createHttp();
  let released = false;
  let release = (): void => {
    if (released) { return; }
    released = true;
    request.destroy();
  };
  let timeout = setTimeout(release, 10000);
  try {
    let response = await request.request('https://www.onorca.dev/v1/feedback', {
      method: http.RequestMethod.POST, header: { 'Content-Type': 'application/json' }, extraData: JSON.stringify(payload),
      connectTimeout: 10000, readTimeout: 10000, usingCache: false
    });
    return response.responseCode >= 200 && response.responseCode < 300;
  } catch (e) { return false; }
  finally { clearTimeout(timeout); release(); }
}
