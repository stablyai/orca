/**
 * Tính toán tỷ lệ phần trăm sử dụng CPU từ dữ liệu thô của hệ thống.
 * Không dùng enum và không phụ thuộc bên ngoài để tương thích với erasableSyntaxOnly.
 */

export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

/**
 * Gom tổng thời gian CPU (idle và total) của tất cả các nhân.
 * @param cpus Danh sách thông tin CPU trả về từ hệ thống (ví dụ os.cpus())
 */
export function toCpuTimes(cpus: readonly { times: Record<string, number> }[]): CpuTimes {
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const [key, value] of Object.entries(cpu.times)) {
      total += value;
      if (key === 'idle') {
        idle += value;
      }
    }
  }

  return { idle, total };
}

/**
 * Tính phần trăm CPU được dùng trong khoảng thời gian giữa hai mẫu đo.
 * Đảm bảo kết quả luôn nằm trong khoảng 0..100 và không trả về NaN.
 */
export function computeCpuPercent(prev: CpuTimes, curr: CpuTimes): number {
  const totalDelta = curr.total - prev.total;
  const idleDelta = curr.idle - prev.idle;

  // Nếu tổng delta <= 0 (bộ đếm đứng yên hoặc bộ đếm lùi do tràn số hệ thống), kẹp về 0
  if (totalDelta <= 0) {
    return 0;
  }

  // Tỷ lệ CPU bận rộn = (tổng thời gian thay đổi - thời gian rỗi) / tổng thời gian thay đổi
  const usedDelta = totalDelta - idleDelta;
  if (usedDelta <= 0) {
    return 0;
  }

  const percent = (usedDelta / totalDelta) * 100;
  return Math.min(100, Math.max(0, percent));
}
