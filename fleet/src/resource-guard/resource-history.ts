/**
 * Quản lý lịch sử các mẫu đo tài nguyên hệ thống theo cửa sổ trượt (sliding window).
 * Hàm thuần tuý, bất biến, không gọi Date.now().
 */

export interface ResourceSample {
  readonly at: number;
  readonly freeMemBytes: number;
  readonly cpuPercent?: number;
}

/**
 * Thêm một mẫu đo mới vào lịch sử và dọn dẹp các mẫu quá hạn.
 * Bất biến: giữ nguyên mảng ban đầu và trả về mảng mới.
 * Đồng hồ lùi (s.at < mẫu cuối cùng) -> bỏ qua mẫu, không ném lỗi.
 * Cắt mẫu cũ nhưng luôn giữ lại đúng 1 mẫu mới nhất có at <= s.at - windowMs (để chứng minh dữ liệu phủ đủ cửa sổ).
 */
export function addSample(
  history: readonly ResourceSample[],
  s: ResourceSample,
  windowMs: number
): ResourceSample[] {
  // Kiểm tra đồng hồ lùi: nếu timestamp nhỏ hơn mẫu gần nhất thì bỏ qua
  const lastSample = history[history.length - 1];
  if (lastSample && s.at < lastSample.at) {
    return [...history];
  }

  const updated = [...history, s];
  const threshold = s.at - windowMs;

  // Tìm vị trí của mẫu mới nhất có at <= threshold
  let coverIndex = -1;
  for (let i = updated.length - 1; i >= 0; i--) {
    const item = updated[i];
    if (item && item.at <= threshold) {
      coverIndex = i;
      break;
    }
  }

  // Nếu tìm thấy mẫu phủ biên, cắt mảng từ mẫu đó trở đi (bỏ các mẫu cũ hơn nó)
  if (coverIndex >= 0) {
    return updated.slice(coverIndex);
  }

  // Nếu chưa có mẫu nào chạm ngưỡng phủ, giữ lại toàn bộ mẫu
  return updated;
}
