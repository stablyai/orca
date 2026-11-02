export type FontVariationInstance = {
  subfamilyNameId: number
  /** Raw 16.16 fixed-point coordinates keyed by axis tag. */
  coordinates: Map<number, number>
}

type StyleAxis = { tag: number; ordering: number }
type AxisValue = { axisIndex: number; nameId: number; elidable: boolean; min: number; max: number }

const ELIDABLE_AXIS_VALUE_FLAG = 0x0002

export function parseFontVariationInstances(fvar: Buffer): FontVariationInstance[] {
  if (fvar.length < 16) {
    return []
  }
  const axesOffset = fvar.readUInt16BE(4)
  const axisCount = fvar.readUInt16BE(8)
  const axisSize = fvar.readUInt16BE(10)
  const instanceCount = fvar.readUInt16BE(12)
  const instanceSize = fvar.readUInt16BE(14)
  const instancesOffset = axesOffset + axisCount * axisSize
  if (axisSize < 4 || instanceSize < 4 + axisCount * 4 || instancesOffset > fvar.length) {
    return []
  }
  const axisTags = Array.from({ length: axisCount }, (_, index) =>
    fvar.readUInt32BE(axesOffset + index * axisSize)
  )
  const instances: FontVariationInstance[] = []
  for (let index = 0; index < instanceCount; index++) {
    const instance = instancesOffset + index * instanceSize
    if (instance + instanceSize > fvar.length) {
      break
    }
    instances.push({
      subfamilyNameId: fvar.readUInt16BE(instance),
      coordinates: new Map(
        axisTags.map((tag, axis) => [tag, fvar.readInt32BE(instance + 4 + axis * 4)])
      )
    })
  }
  return instances
}

/**
 * Name IDs spelling an instance's style in STAT axis order, which is how Windows names variable
 * instances ("Display Light", not fvar's "Light Display"). Null when STAT cannot name every axis.
 */
export function createStatStyleNamer(
  stat: Buffer | null
): (instance: FontVariationInstance) => number[] | null {
  const parsed = stat ? parseStyleAttributes(stat) : null
  if (!parsed) {
    return () => null
  }
  const orderedAxes = parsed.axes
    .map((axis, axisIndex) => ({ ...axis, axisIndex }))
    .sort((a, b) => a.ordering - b.ordering)
  return (instance) => {
    const nameIds: number[] = []
    for (const axis of orderedAxes) {
      const coordinate = instance.coordinates.get(axis.tag)
      if (coordinate === undefined) {
        continue
      }
      const matches = parsed.values.filter(
        (candidate) =>
          candidate.axisIndex === axis.axisIndex &&
          candidate.min <= coordinate &&
          coordinate <= candidate.max
      )
      const value = matches.find((match) => match.min === match.max) ?? matches[0]
      if (!value) {
        return null
      }
      if (!value.elidable) {
        nameIds.push(value.nameId)
      }
    }
    return nameIds
  }
}

function parseStyleAttributes(stat: Buffer): { axes: StyleAxis[]; values: AxisValue[] } | null {
  if (stat.length < 18) {
    return null
  }
  const designAxisSize = stat.readUInt16BE(4)
  const designAxisCount = stat.readUInt16BE(6)
  const designAxesOffset = stat.readUInt32BE(8)
  const axisValueCount = stat.readUInt16BE(12)
  const axisValueOffsetsOffset = stat.readUInt32BE(14)
  if (
    designAxisSize < 8 ||
    designAxesOffset + designAxisCount * designAxisSize > stat.length ||
    axisValueOffsetsOffset + axisValueCount * 2 > stat.length
  ) {
    return null
  }
  const axes = Array.from({ length: designAxisCount }, (_, index) => {
    const record = designAxesOffset + index * designAxisSize
    return { tag: stat.readUInt32BE(record), ordering: stat.readUInt16BE(record + 6) }
  })
  const values: AxisValue[] = []
  for (let index = 0; index < axisValueCount; index++) {
    const value = axisValueOffsetsOffset + stat.readUInt16BE(axisValueOffsetsOffset + index * 2)
    const parsed = parseAxisValue(stat, value)
    if (parsed) {
      values.push(parsed)
    }
  }
  return { axes, values }
}

// Formats 1 and 3 name one coordinate, format 2 a range; format 4 combines axes and is skipped.
function parseAxisValue(stat: Buffer, offset: number): AxisValue | null {
  if (offset + 12 > stat.length) {
    return null
  }
  const format = stat.readUInt16BE(offset)
  const base = {
    axisIndex: stat.readUInt16BE(offset + 2),
    elidable: (stat.readUInt16BE(offset + 4) & ELIDABLE_AXIS_VALUE_FLAG) !== 0,
    nameId: stat.readUInt16BE(offset + 6)
  }
  if (format === 1 || format === 3) {
    const value = stat.readInt32BE(offset + 8)
    return { ...base, min: value, max: value }
  }
  if (format === 2 && offset + 20 <= stat.length) {
    return { ...base, min: stat.readInt32BE(offset + 12), max: stat.readInt32BE(offset + 16) }
  }
  return null
}
