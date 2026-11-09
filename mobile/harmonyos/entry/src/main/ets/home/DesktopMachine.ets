import upstream from '../vendor/host-machine.js';

interface HostMachine { kind: string; model: string | null; }

export interface DesktopMachine {
  kind: string;
  line: string;
}

const model: ESObject = upstream;

export function readDesktopMachine(status: Record<string, Object>): DesktopMachine {
  let raw = status['hostMachine'];
  let machine: HostMachine | null = null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    let fields = raw as Record<string, Object>;
    let kind = fields['kind'];
    if (typeof kind === 'string' && (kind === 'laptop' || kind === 'desktop' || kind === 'server')) {
      let rawLabel = fields['model'];
      let label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
      machine = { kind: kind, model: label && label.length <= 128 ? label : null };
    }
  }
  let line = model.formatHostMachineLine(machine, model.readMobileRuntimeHostPlatform(status)) as string | null;
  return { kind: machine?.kind ?? '', line: line ?? '' };
}
