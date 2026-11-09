import upstream from '../vendor/host-machine.js';

export interface HostMachine { kind: string; model: string | null; }

export interface HostMachineDescriptor {
  hostPlatform?: string;
  hostMachine?: HostMachine;
}

const model: ESObject = upstream;

export function readHostMachineDescriptor(status: Record<string, Object>): HostMachineDescriptor {
  let raw = status['hostMachine'];
  let machine: HostMachine | undefined = undefined;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    let fields = raw as Record<string, Object>;
    let kind = fields['kind'];
    if (typeof kind === 'string' && (kind === 'laptop' || kind === 'desktop' || kind === 'server')) {
      let rawLabel = fields['model'];
      let label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
      machine = { kind: kind, model: label && label.length <= 128 ? label : null };
    }
  }
  let platform = model.readMobileRuntimeHostPlatform(status) as string | null;
  return { hostPlatform: platform ?? undefined, hostMachine: machine };
}

export function hostMachineLine(descriptor: HostMachineDescriptor): string {
  let line = model.formatHostMachineLine(descriptor.hostMachine, descriptor.hostPlatform) as string | null;
  return line ?? '';
}
