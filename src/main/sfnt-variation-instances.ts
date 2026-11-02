export type FontVariationInstance = {
  subfamilyNameId: number
  /** Raw 16.16 fixed-point coordinates keyed by axis tag. */
  coordinates: Map<number, number>
}

type StyleAxis = { tag: number; ordering: number }
type AxisCondition = { axisIndex: number; min: number; max: number }
type AxisValue = { conditions: AxisCondition[]; nameId: number; elidable: boolean }

const ELIDABLE_AXIS_VALUE_FLAG = 0x0002
const SUBFAMILY_NAME_ID = 2

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
  if (axisSize < 12 || instanceSize < 4 + axisCount * 4 || instancesOffset > fvar.length) {
    return []
  }
  const axes = Array.from({ length: axisCount }, (_, index) => {
    const record = axesOffset + index * axisSize
    return { tag: fvar.readUInt32BE(record), defaultValue: fvar.readInt32BE(record + 8) }
  })
  const instances: FontVariationInstance[] = []
  for (let index = 0; index < instanceCount; index++) {
    const instance = instancesOffset + index * instanceSize
    if (instance + instanceSize > fvar.length) {
      break
    }
    instances.push({
      subfamilyNameId: fvar.readUInt16BE(instance),
      coordinates: new Map(
        axes.map(({ tag }, axis) => [tag, fvar.readInt32BE(instance + 4 + axis * 4)])
      )
    })
  }
  // The default instance exists even when fvar lists no record for it.
  const isDefault = (instance: FontVariationInstance): boolean =>
    axes.every(({ tag, defaultValue }) => instance.coordinates.get(tag) === defaultValue)
  if (!instances.some(isDefault)) {
    instances.push({
      subfamilyNameId: SUBFAMILY_NAME_ID,
      coordinates: new Map(axes.map(({ tag, defaultValue }) => [tag, defaultValue]))
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
  // Multi-axis (format 4) values outrank single-axis ones, and exact values outrank ranges.
  const values = [...parsed.values].sort(
    (a, b) => b.conditions.length - a.conditions.length || rangeWidth(a) - rangeWidth(b)
  )
  return (instance) => {
    const coordinateOf = (axisIndex: number): number | undefined => {
      const axis = parsed.axes[axisIndex]
      return axis ? instance.coordinates.get(axis.tag) : undefined
    }
    const covered = new Set<number>()
    const named: { ordering: number; value: AxisValue }[] = []
    for (const value of values) {
      const matches = value.conditions.every(({ axisIndex, min, max }) => {
        const coordinate = coordinateOf(axisIndex)
        return (
          !covered.has(axisIndex) &&
          coordinate !== undefined &&
          min <= coordinate &&
          coordinate <= max
        )
      })
      if (!matches) {
        continue
      }
      for (const { axisIndex } of value.conditions) {
        covered.add(axisIndex)
      }
      const ordering = Math.min(
        ...value.conditions.map(
          ({ axisIndex }) => parsed.axes[axisIndex]?.ordering ?? Number.MAX_SAFE_INTEGER
        )
      )
      named.push({ ordering, value })
    }
    const unnamedAxis = parsed.axes.some(
      (axis, axisIndex) => instance.coordinates.has(axis.tag) && !covered.has(axisIndex)
    )
    if (unnamedAxis) {
      return null
    }
    return named
      .sort((a, b) => a.ordering - b.ordering)
      .flatMap(({ value }) => (value.elidable ? [] : [value.nameId]))
  }
}

function rangeWidth(value: AxisValue): number {
  const condition = value.conditions[0]
  return value.conditions.length === 1 && condition ? condition.max - condition.min : 0
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

// Formats 1 and 3 name one coordinate, format 2 a range, format 4 a combination of axes.
function parseAxisValue(stat: Buffer, offset: number): AxisValue | null {
  if (offset + 12 > stat.length) {
    return null
  }
  const format = stat.readUInt16BE(offset)
  const elidable = (stat.readUInt16BE(offset + 4) & ELIDABLE_AXIS_VALUE_FLAG) !== 0
  const nameId = stat.readUInt16BE(offset + 6)
  const axisIndex = stat.readUInt16BE(offset + 2)
  if (format === 1 || format === 3) {
    const value = stat.readInt32BE(offset + 8)
    return { conditions: [{ axisIndex, min: value, max: value }], nameId, elidable }
  }
  if (format === 2 && offset + 20 <= stat.length) {
    const min = stat.readInt32BE(offset + 12)
    const max = stat.readInt32BE(offset + 16)
    return { conditions: [{ axisIndex, min, max }], nameId, elidable }
  }
  // Format 4 stores its axis count where the other formats store the axis index.
  if (format === 4 && axisIndex > 0 && offset + 8 + axisIndex * 6 <= stat.length) {
    const conditions = Array.from({ length: axisIndex }, (_, index) => {
      const record = offset + 8 + index * 6
      const value = stat.readInt32BE(record + 2)
      return { axisIndex: stat.readUInt16BE(record), min: value, max: value }
    })
    return { conditions, nameId, elidable }
  }
  return null
}
