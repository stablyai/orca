/**
 * Tương tác với phần cứng hệ thống (RAM, CPU) qua interface trừu tượng SystemProbe.
 * Hỗ trợ mock toàn diện cho test mà không phụ thuộc vào hệ điều hành thật.
 */

import os from 'node:os';
import { computeCpuPercent, toCpuTimes, type CpuTimes } from './cpu-usage.ts';
import { addSample, type ResourceSample } from './resource-history.ts';
import {
  DEFAULT_LIMITS,
  evaluateResources,
  type ResourceLimits,
  type ResourceVerdict
} from './resource-guard.ts';

export interface SystemProbe {
  now(): number;
  freemem(): number;
  cpus(): { times: Record<string, number> }[];
}

/**
 * Triển khai SystemProbe thật bằng module node:os tiêu chuẩn.
 * Tuyệt đối không dùng os.loadavg() vì luôn trả về 0 trên Windows.
 */
export const nodeSystemProbe: SystemProbe = {
  now: () => Date.now(),
  freemem: () => os.freemem(),
  cpus: () => os.cpus()
};

export interface ResourceGuardOptions {
  readonly probe?: SystemProbe;
  readonly limits?: Partial<ResourceLimits>;
}

export interface ResourceGuard {
  /** Lấy mẫu tài nguyên tại thời điểm hiện tại và lưu vào lịch sử */
  sample(): void;
  /** Kiểm tra tài nguyên hiện tại để trả về quyết định dispatch */
  check(): ResourceVerdict;
  /** Lấy bản sao lịch sử các mẫu đo hiện tại (chỉ đọc) */
  getHistory(): readonly ResourceSample[];
}

/**
 * Khởi tạo bộ giám sát tài nguyên ResourceGuard.
 * Không tự tạo timer ngầm; việc gọi sample() và check() do caller (vòng lặp Fleet) điều phối.
 */
export function createResourceGuard(options: ResourceGuardOptions = {}): ResourceGuard {
  const probe = options.probe ?? nodeSystemProbe;
  const limits: ResourceLimits = {
    minFreeMemBytes: options.limits?.minFreeMemBytes ?? DEFAULT_LIMITS.minFreeMemBytes,
    cpuPercentLimit: options.limits?.cpuPercentLimit ?? DEFAULT_LIMITS.cpuPercentLimit,
    cpuWindowMs: options.limits?.cpuWindowMs ?? DEFAULT_LIMITS.cpuWindowMs
  };

  let history: ResourceSample[] = [];
  let prevCpuTimes: CpuTimes | undefined = undefined;

  return {
    sample(): void {
      const now = probe.now();
      const freeMemBytes = probe.freemem();
      const cpus = probe.cpus();
      const currCpuTimes = toCpuTimes(cpus);

      let cpuPercent: number | undefined = undefined;
      if (prevCpuTimes !== undefined) {
        cpuPercent = computeCpuPercent(prevCpuTimes, currCpuTimes);
      }
      prevCpuTimes = currCpuTimes;

      const newSample: ResourceSample = {
        at: now,
        freeMemBytes,
        ...(cpuPercent !== undefined ? { cpuPercent } : {})
      };

      history = addSample(history, newSample, limits.cpuWindowMs);
    },

    check(): ResourceVerdict {
      return evaluateResources(history, probe.now(), limits);
    },

    getHistory(): readonly ResourceSample[] {
      return [...history];
    }
  };
}
