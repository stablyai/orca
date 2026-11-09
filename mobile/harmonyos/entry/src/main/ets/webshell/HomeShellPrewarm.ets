import { appManager, common } from '@kit.AbilityKit';
import { UIContext } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { appendLog, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { WebBundleFetcher } from '../transport/WebBundleFetcher';
import { ShellDocument } from './ShellDocument';

interface PrewarmSource {
  hostId: string;
  client: SpikeRpcClient;
  isCurrent: () => boolean;
}
interface SpareDocument {
  hostId: string;
  document: ShellDocument;
}

let homeShown = false;
let suppressed = false;
let engineReady = false;
let schedule = -1;
let dropTimer = -1;
let revision = 0;
let source: PrewarmSource | null = null;
let spare: SpareDocument | null = null;

function clearSchedule(): void {
  revision++;
  if (schedule >= 0) { clearTimeout(schedule); schedule = -1; }
  source = null;
}

function clearDrop(): void {
  if (dropTimer >= 0) { clearTimeout(dropTimer); dropTimer = -1; }
}

function discardSpare(): void {
  let previous = spare; spare = null;
  previous?.document.dispose();
}

export function enterHomePrewarm(): void {
  if (!homeShown) { suppressed = false; clearSchedule(); }
  homeShown = true; clearDrop();
}

export function leaveHomePrewarm(): void {
  homeShown = false; clearSchedule(); clearDrop();
  if (spare) { dropTimer = setTimeout((): void => { dropTimer = -1; discardSpare(); }, 2000); }
}

export function dropHomePrewarm(): void {
  homeShown = false; clearSchedule(); clearDrop(); discardSpare();
}

export function dropPrewarmForMemoryPressure(): void {
  suppressed = true; clearSchedule(); clearDrop(); discardSpare();
}

export function invalidateHomePrewarm(hostId: string): void {
  if (source?.hostId === hostId) { clearSchedule(); }
  if (spare?.hostId === hostId) { clearDrop(); discardSpare(); }
}

export function scheduleHomePrewarm(ui: UIContext, context: common.UIAbilityContext,
  hostId: string, client: SpikeRpcClient, isCurrent: () => boolean): void {
  if (!homeShown || suppressed || (source?.hostId === hostId && source?.client === client)) { return; }
  clearSchedule();
  let planned: PrewarmSource = { hostId: hostId, client: client, isCurrent: isCurrent };
  source = planned;
  let currentRevision = revision;
  schedule = setTimeout((): void => {
    schedule = -1;
    prepare(ui, context, planned, currentRevision).catch(() => {});
  }, 1000);
}

async function prepare(ui: UIContext, context: common.UIAbilityContext, planned: PrewarmSource, expected: number): Promise<void> {
  let allowed = (): boolean => expected === revision && homeShown && !suppressed && planned.isCurrent();
  if (!allowed() || await appManager.isRamConstrainedDevice() || !allowed()) { return; }
  if (!engineReady) {
    webview.WebviewController.initializeWebEngine();
    engineReady = true;
  }
  let fetcher = new WebBundleFetcher(planned.client, context);
  let manifest = await fetcher.fetchManifest();
  if (!allowed()) { return; }
  let dir = await fetcher.ensureBundle(manifest);
  if (!allowed()) { return; }
  if (spare?.hostId === planned.hostId && spare?.document.baseDir === dir) { return; }
  discardSpare();
  let document = new ShellDocument(manifest, dir, true);
  spare = { hostId: planned.hostId, document: document };
  document.onReady = (): void => {
    if (spare?.document === document) {
      appendLog(context, LOG_LEVEL_INFO, '会话页面已预热', '', planned.hostId, 'web-shell-flow').catch(() => {});
    }
  };
  document.onFailure = (): void => {
    if (spare?.document === document) { discardSpare(); }
  };
  try { document.prepare(ui); }
  catch (e) { if (spare?.document === document) { discardSpare(); } }
}

export function claimHomeDocument(hostId: string, dir: string): ShellDocument | null {
  let previous = spare;
  if (!previous) { return null; }
  clearDrop(); spare = null;
  let document = previous.document;
  if (previous.hostId === hostId && document.baseDir === dir && document.isReady()) { return document; }
  document.dispose();
  return null;
}
