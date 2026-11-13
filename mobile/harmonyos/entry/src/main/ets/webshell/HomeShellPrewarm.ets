import { appManager, common } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { systemDateTime } from '@kit.BasicServicesKit';
import { appendLog, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { HostMeta } from '../storage/HostStore';
import { BundleManifest, WebBundleFetcher } from '../transport/WebBundleFetcher';
import { ShellDocument } from './ShellDocument';

interface SpareDocument {
  hostId: string;
  pairedAt: number;
  document: ShellDocument;
}

const HOME_SPARE_IDLE_MS = 1000;
const HOME_SPARE_CLAIM_GRACE_MS = 2000;
const HOME_SPARE_REFILL_BACKOFF_MS = 30_000;
const MEMORY_WARNING_BACKOFF_MS = 180_000;

let homeShown = false;
let engineReady = false;
let schedule = -1;
let dropTimer = -1;
let revision = 0;
let prewarmAllowedAt = 0;
let spare: SpareDocument | null = null;

function clearSchedule(): void {
  revision++;
  if (schedule >= 0) { clearTimeout(schedule); schedule = -1; }
}

function clearDrop(): void {
  if (dropTimer >= 0) { clearTimeout(dropTimer); dropTimer = -1; }
}

function discardSpare(): void {
  let previous = spare; spare = null;
  previous?.document.dispose();
}

function uptime(): number {
  return systemDateTime.getUptime(systemDateTime.TimeType.ACTIVE);
}

function deferPrewarm(ms: number): void {
  prewarmAllowedAt = Math.max(prewarmAllowedAt, uptime() + ms);
}

export function enterHomePrewarm(): void {
  homeShown = true; clearDrop();
}

export function leaveHomePrewarm(): void {
  homeShown = false; clearSchedule(); clearDrop();
  if (spare) {
    dropTimer = setTimeout((): void => {
      dropTimer = -1;
      deferPrewarm(HOME_SPARE_REFILL_BACKOFF_MS);
      discardSpare();
    }, HOME_SPARE_CLAIM_GRACE_MS);
  }
}

export function dropHomePrewarm(): void {
  homeShown = false; clearSchedule(); clearDrop(); discardSpare();
}

export function dropPrewarmForMemoryPressure(): void {
  deferPrewarm(MEMORY_WARNING_BACKOFF_MS);
  clearSchedule(); clearDrop(); discardSpare();
}

export function invalidateHomePrewarm(hostId: string): void {
  clearSchedule();
  if (spare?.hostId === hostId) { clearDrop(); discardSpare(); }
}

export function scheduleHomePrewarm(ui: UIContext, context: common.UIAbilityContext,
  hosts: HostMeta[]): void {
  if (!homeShown) { return; }
  clearSchedule();
  if (spare) {
    let hostId = spare.hostId;
    let pairedAt = spare.pairedAt;
    if (!hosts.some((host: HostMeta): boolean => host.id === hostId && host.lastConnected === pairedAt)) { discardSpare(); }
  }
  if (hosts.length === 0) { return; }
  let currentRevision = revision;
  schedule = setTimeout((): void => {
    schedule = -1;
    prepare(ui, context, hosts, currentRevision).catch(() => {});
  }, Math.max(HOME_SPARE_IDLE_MS, prewarmAllowedAt - uptime()));
}

async function prepare(ui: UIContext, context: common.UIAbilityContext, hosts: HostMeta[], expected: number): Promise<void> {
  let allowed = (): boolean => expected === revision && homeShown && uptime() >= prewarmAllowedAt;
  if (!allowed() || await appManager.isRamConstrainedDevice() || !allowed()) { return; }
  for (let i = 0; i < hosts.length; i++) {
    let host = hosts[i];
    let cached = WebBundleFetcher.readPairedBundle(context, host.id, host.lastConnected);
    if (cached) { park(ui, context, host, cached.manifest, cached.directory); return; }
  }
  discardSpare();
}

function park(ui: UIContext, context: common.UIAbilityContext, host: HostMeta,
  manifest: BundleManifest, dir: string): void {
  if (spare?.hostId === host.id && spare.pairedAt === host.lastConnected && spare.document.baseDir === dir) { return; }
  if (!engineReady) {
    webview.WebviewController.initializeWebEngine();
    engineReady = true;
  }
  discardSpare();
  let document = new ShellDocument(manifest, dir, true);
  spare = { hostId: host.id, pairedAt: host.lastConnected, document: document };
  document.onReady = (): void => {
    if (spare?.document === document) {
      appendLog(context, LOG_LEVEL_INFO, '会话页面已预热', '', host.id, 'web-shell-flow').catch(() => {});
    }
  };
  document.onFailure = (): void => {
    if (spare?.document === document) { discardSpare(); }
  };
  try { document.prepare(ui); }
  catch (e) { if (spare?.document === document) { discardSpare(); } }
}

export function claimHomeDocument(host: HostMeta, dir: string): ShellDocument | null {
  let previous = spare;
  if (!previous) { return null; }
  clearDrop(); spare = null;
  let document = previous.document;
  if (previous.hostId === host.id && previous.pairedAt === host.lastConnected && document.baseDir === dir && document.isReady()) {
    return document;
  }
  document.dispose();
  return null;
}
