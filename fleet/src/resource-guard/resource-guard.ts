/**
 * Đánh giá tài nguyên máy chủ để quyết định có hoãn dispatch worker hay không.
 * Cổng kiểm soát tài nguyên Phase 3.4 (DoD 3.4).
 */

import type { ResourceSample } from './resource-history.ts';

export interface ResourceLimits {
  /** Bộ nhớ RAM trống tối thiểu (bytes) */
  readonly minFreeMemBytes: number;
  /** Ngưỡng CPU tối đa (0..100) */
  readonly cpuPercentLimit: number;
  /** Cửa sổ thời gian CPU cao liên tục (ms) */
  readonly cpuWindowMs: number;
}

export const DEFAULT_LIMITS: ResourceLimits = {
  minFreeMemBytes: 4 * 1024 ** 3,
  cpuPercentLimit: 85,
  cpuWindowMs: 120_000
};

export function resolveLimits(custom?: Partial<ResourceLimits>): ResourceLimits {
  return {
    minFreeMemBytes: custom?.minFreeMemBytes ?? DEFAULT_LIMITS.minFreeMemBytes,
    cpuPercentLimit: custom?.cpuPercentLimit ?? DEFAULT_LIMITS.cpuPercentLimit,
    cpuWindowMs: custom?.cpuWindowMs ?? DEFAULT_LIMITS.cpuWindowMs
  };
}

export type DeferReason =
  | { readonly type: 'no-samples' }
  | {
      readonly type: 'low-memory';
      readonly freeMemBytes: number;
      readonly minFreeMemBytes: number;
    }
  | {
      readonly type: 'high-cpu';
      readonly windowMs: number;
      readonly lowestCpuPercent: number;
    };

export type ResourceVerdict =
  | { readonly dispatch: true }
  | { readonly dispatch: false; readonly reasons: readonly DeferReason[] };

/**
 * Đánh giá các mẫu tài nguyên trong lịch sử dựa trên ngưỡng cấu hình.
 * Hàm thuần tuý, không gọi Date.now().
 */
export function evaluateResources(
  history: readonly ResourceSample[],
  now: number,
  customLimits?: Partial<ResourceLimits>
): ResourceVerdict {
  const limits = resolveLimits(customLimits);

  // Nếu chưa có mẫu nào: fail-closed vì chưa biết trạng thái RAM
  if (history.length === 0) {
    return {
      dispatch: false,
      reasons: [{ type: 'no-samples' }]
    };
  }

  const reasons: DeferReason[] = [];

  // 1. Kiểm tra RAM: chỉ xét mẫu mới nhất
  const latestSample = history[history.length - 1];
  if (!latestSample) {
    return {
      dispatch: false,
      reasons: [{ type: 'no-samples' }]
    };
  }

  if (latestSample.freeMemBytes < limits.minFreeMemBytes) {
    reasons.push({
      type: 'low-memory',
      freeMemBytes: latestSample.freeMemBytes,
      minFreeMemBytes: limits.minFreeMemBytes
    });
  }

  // 2. Kiểm tra CPU: xem có duy trì liên tục trên ngưỡng trong suốt cửa sổ hay không
  const cpuThreshold = now - limits.cpuWindowMs;
  let coverIndex = -1;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item && item.at <= cpuThreshold) {
      coverIndex = i;
      break;
    }
  }

  // Nếu tồn tại mẫu phủ (đủ dữ liệu từ now - windowMs đến nay)
  if (coverIndex >= 0) {
    const windowSamples = history.slice(coverIndex);
    let allHigh = true;
    let lowest = Infinity;

    for (const sample of windowSamples) {
      // Nếu thiếu thông tin CPU hoặc CPU không vượt ngưỡng (<= 85%), không tính là cao liên tục
      if (sample.cpuPercent === undefined || sample.cpuPercent <= limits.cpuPercentLimit) {
        allHigh = false;
        break;
      }
      if (sample.cpuPercent < lowest) {
        lowest = sample.cpuPercent;
      }
    }

    if (allHigh && windowSamples.length > 0) {
      reasons.push({
        type: 'high-cpu',
        windowMs: limits.cpuWindowMs,
        lowestCpuPercent: lowest
      });
    }
  }

  if (reasons.length > 0) {
    return { dispatch: false, reasons };
  }

  return { dispatch: true };
}

/**
 * Định dạng thông báo lý do hoãn dispatch bằng tiếng Việt để ghi log.
 */
export function formatDeferReason(reason: DeferReason): string {
  switch (reason.type) {
    case 'no-samples':
      return 'Hoãn dispatch: Chưa có mẫu đo tài nguyên hệ thống.';
    case 'low-memory': {
      const freeGib = (reason.freeMemBytes / 1024 ** 3).toFixed(1);
      const minGib = (reason.minFreeMemBytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '');
      return `Hoãn dispatch: RAM trống ${freeGib} GiB < ${minGib} GiB.`;
    }
    case 'high-cpu': {
      const mins = Math.round(reason.windowMs / 60_000);
      return `Hoãn dispatch: CPU duy trì cao liên tục trong ${mins} phút (thấp nhất ${reason.lowestCpuPercent.toFixed(1)}%).`;
    }
  }
}
