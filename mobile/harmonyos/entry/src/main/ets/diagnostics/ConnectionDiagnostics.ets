import { url } from '@kit.ArkTS';
import { http } from '@kit.NetworkKit';
import { bundleManager } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import upstream from '../vendor/connection-diagnostics.js';
import { utf8Encode } from '../transport/crypto/Bytes';
import type { ConnectionLogEntry } from './ConnectionLogStore';
import { uiText } from '../settings/NativeUi';

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

export interface DesktopConnectionEvidence {
  state: string;
  endpoint: string;
  hostName: string;
  lastConnectedAt: number | null;
  reconnectAttempts: number;
  pendingPath?: string;
  relayHostReachability?: string;
  nowMs: number;
}

export interface DesktopConnectionVerdict {
  kind: string;
  label: string;
  detail?: string;
}

export function describeDesktopConnection(evidence: DesktopConnectionEvidence, locale: string): DesktopConnectionVerdict {
  return model.describeDesktopConnection(evidence, (key: string, fallback: string): string => {
    let label = uiText(key, locale);
    return label === key ? fallback : label;
  }) as DesktopConnectionVerdict;
}

export class RelayHostReachability {
  private latch: ESObject = model.createRelayHostReachability();

  current(): string { return this.latch.current() as string; }
  clear(): void { this.latch.clear(); }

  record(code: number, reason: string): void {
    let explicit = model.relayHostCloseReasonFrom(reason) as string | null;
    if (explicit) { this.latch.assert(explicit); }
    else { this.latch.record(model.relayHostReachabilityForCloseCode(code)); }
  }
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
export interface TroubleshootIssue {
  id: string;
  kind: string;
  title: string;
  steps: string[];
}

export function troubleshootIssues(endpoints: string[], locale: string): TroubleshootIssue[] {
  return model.getTroubleshootCommonIssues(endpoints, (key: string, fallback: string): string => {
    let nativeKey = key === 'diagnostics.troubleshootCommonIssues.notificationsTitle' ? '在线通知' :
      key === 'diagnostics.troubleshootCommonIssues.notificationNetwork' ? '保持 Orca 运行并连接桌面。' :
      key === 'diagnostics.troubleshootCommonIssues.restartTailscale' ? '在手机上关闭再开启 Tailscale，然后重试。' : key;
    let label = uiText(nativeKey, locale);
    return nativeKey === key && label === key ? fallback : label;
  }) as TroubleshootIssue[];
}

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

export async function sendConnectionReport(report: string, version: string, platform: string): Promise<boolean> {
  let body = model.serializeConnectionDiagnosticsSubmission({ report: report, appVersion: version, platform: platform }) as string;
  let request = http.createHttp();
  let released = false;
  let release = (): void => {
    if (released) { return; }
    released = true;
    try { request.destroy(); } catch (e) {}
  };
  let timeout = setTimeout(release, 10000);
  try {
    let response = await request.request(model.CONNECTION_DIAGNOSTICS_ENDPOINT as string, {
      method: http.RequestMethod.POST, header: { 'Content-Type': 'application/json' }, extraData: body,
      connectTimeout: 10000, readTimeout: 10000, usingCache: false
    });
    return response.responseCode >= 200 && response.responseCode < 300;
  } catch (e) { return false; }
  finally { clearTimeout(timeout); release(); }
}
