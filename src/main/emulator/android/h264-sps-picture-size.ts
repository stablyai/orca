// Reads the cropped picture size from the SPS in an Annex-B H.264 config packet
// (ITU-T H.264 section 7.3.2.1.1). scrcpy v2.4 reports the video size once in its
// codec meta; after a rotation the new size is only carried by the next SPS.

export type H264PictureSize = { width: number; height: number }

const NAL_TYPE_SPS = 7
// Profiles whose SPS carries chroma format, bit depth and scaling matrix fields.
const HIGH_PROFILE_IDCS = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

class BitReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.offset >> 3]
    if (byte === undefined) {
      throw new RangeError('SPS ended early')
    }
    const value = (byte >> (7 - (this.offset & 7))) & 1
    this.offset += 1
    return value
  }

  bits(count: number): number {
    let value = 0
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + this.bit()
    }
    return value
  }

  // Exp-Golomb ue(v).
  ue(): number {
    let leadingZeros = 0
    while (this.bit() === 0) {
      leadingZeros += 1
      if (leadingZeros > 31) {
        throw new RangeError('Invalid Exp-Golomb code')
      }
    }
    return 2 ** leadingZeros - 1 + this.bits(leadingZeros)
  }

  // Exp-Golomb se(v).
  se(): number {
    const value = this.ue()
    return value % 2 === 1 ? (value + 1) / 2 : -(value / 2)
  }
}

function findSpsRbsp(annexB: Uint8Array): Uint8Array | null {
  for (let index = 0; index + 3 < annexB.length; index += 1) {
    if (annexB[index] !== 0 || annexB[index + 1] !== 0 || annexB[index + 2] !== 1) {
      continue
    }
    const header = index + 3
    if ((annexB[header] & 0x1f) !== NAL_TYPE_SPS) {
      continue
    }
    // Drop emulation prevention bytes (00 00 03) up to the next start code.
    const rbsp = new Uint8Array(annexB.length - header)
    let length = 0
    let zeros = 0
    for (let cursor = header + 1; cursor < annexB.length; cursor += 1) {
      const byte = annexB[cursor]
      if (zeros >= 2 && byte === 1) {
        break
      }
      if (zeros >= 2 && byte === 3) {
        zeros = 0
        continue
      }
      rbsp[length++] = byte
      zeros = byte === 0 ? zeros + 1 : 0
    }
    return rbsp.subarray(0, length)
  }
  return null
}

function skipScalingLists(reader: BitReader, count: number): void {
  for (let list = 0; list < count; list += 1) {
    if (!reader.bit()) {
      continue
    }
    const size = list < 6 ? 16 : 64
    let lastScale = 8
    let nextScale = 8
    for (let index = 0; index < size; index += 1) {
      if (nextScale !== 0) {
        nextScale = (lastScale + reader.se() + 256) % 256
      }
      lastScale = nextScale === 0 ? lastScale : nextScale
    }
  }
}

function readPictureSize(reader: BitReader): H264PictureSize | null {
  const profileIdc = reader.bits(8)
  reader.bits(16) // constraint_set flags and level_idc
  reader.ue() // seq_parameter_set_id
  let chromaFormatIdc = 1
  let separateColourPlane = 0
  if (HIGH_PROFILE_IDCS.has(profileIdc)) {
    chromaFormatIdc = reader.ue()
    if (chromaFormatIdc === 3) {
      separateColourPlane = reader.bit()
    }
    reader.ue() // bit_depth_luma_minus8
    reader.ue() // bit_depth_chroma_minus8
    reader.bit() // qpprime_y_zero_transform_bypass_flag
    if (reader.bit()) {
      skipScalingLists(reader, chromaFormatIdc === 3 ? 12 : 8)
    }
  }
  reader.ue() // log2_max_frame_num_minus4
  const picOrderCntType = reader.ue()
  if (picOrderCntType === 0) {
    reader.ue() // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    reader.bit() // delta_pic_order_always_zero_flag
    reader.se() // offset_for_non_ref_pic
    reader.se() // offset_for_top_to_bottom_field
    const cycleLength = reader.ue()
    for (let index = 0; index < cycleLength; index += 1) {
      reader.se()
    }
  }
  reader.ue() // max_num_ref_frames
  reader.bit() // gaps_in_frame_num_value_allowed_flag
  const widthInMbs = reader.ue() + 1
  const heightInMapUnits = reader.ue() + 1
  const frameMbsOnly = reader.bit()
  if (!frameMbsOnly) {
    reader.bit() // mb_adaptive_frame_field_flag
  }
  reader.bit() // direct_8x8_inference_flag
  let cropX = 0
  let cropY = 0
  if (reader.bit()) {
    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc
    const cropUnitX = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1
    const cropUnitY = (chromaArrayType === 1 ? 2 : 1) * (2 - frameMbsOnly)
    cropX = (reader.ue() + reader.ue()) * cropUnitX
    cropY = (reader.ue() + reader.ue()) * cropUnitY
  }
  const width = widthInMbs * 16 - cropX
  const height = heightInMapUnits * (2 - frameMbsOnly) * 16 - cropY
  return width > 0 && height > 0 ? { width, height } : null
}

export function parseH264SpsPictureSize(annexB: Uint8Array): H264PictureSize | null {
  const rbsp = findSpsRbsp(annexB)
  if (!rbsp) {
    return null
  }
  try {
    return readPictureSize(new BitReader(rbsp))
  } catch {
    return null
  }
}
