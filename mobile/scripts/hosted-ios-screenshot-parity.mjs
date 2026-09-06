import { readFile } from 'node:fs/promises'
import { PNG } from 'pngjs'

const STATUS_BAR_MASK_RATIO = 0.07
const PIXEL_CHANNEL_DIFFERENCE_THRESHOLD = 24
const COMPARISON_BLOCK_SIZE = 4
const NEIGHBORHOOD_RADIUS_BLOCKS = 4
const MAX_CHANGED_PIXEL_RATIO = 0.03
const MAX_MEAN_CHANNEL_DIFFERENCE = 4
const MAX_LANDMARK_DELTA = 0.005

export async function assertHostedIosScreenshotParity({
  hostedLandmark,
  hostedScreenshot,
  nativeLandmark,
  nativeScreenshot
}) {
  const [nativePng, hostedPng] = await Promise.all([
    readScreenshot(nativeScreenshot),
    readScreenshot(hostedScreenshot)
  ])
  if (nativePng.width !== hostedPng.width || nativePng.height !== hostedPng.height) {
    throw new Error(
      `Screenshot dimensions differ: native ${nativePng.width}x${nativePng.height}, hosted ${hostedPng.width}x${hostedPng.height}`
    )
  }
  const measurements = measureScreenshotDifference(nativePng, hostedPng)
  const landmarkDelta =
    nativeLandmark && hostedLandmark
      ? {
          x: Math.abs(nativeLandmark.x - hostedLandmark.x),
          y: Math.abs(nativeLandmark.y - hostedLandmark.y)
        }
      : null
  const result = {
    ...measurements,
    landmarkDelta,
    // Why: a delta alone cannot say which side moved, and the two landmarks come
    // from different sources (native accessibility frame vs hosted DOM rect).
    landmarks:
      nativeLandmark && hostedLandmark ? { native: nativeLandmark, hosted: hostedLandmark } : null,
    budgets: {
      changedPixelRatio: MAX_CHANGED_PIXEL_RATIO,
      meanChannelDifference: MAX_MEAN_CHANNEL_DIFFERENCE,
      landmarkVerticalDelta: MAX_LANDMARK_DELTA
    }
  }
  if (
    result.changedPixelRatio > MAX_CHANGED_PIXEL_RATIO ||
    result.meanChannelDifference > MAX_MEAN_CHANNEL_DIFFERENCE ||
    (landmarkDelta?.y ?? 0) > MAX_LANDMARK_DELTA
  ) {
    throw new Error(`Hosted screenshot exceeded parity budgets: ${JSON.stringify(result)}`)
  }
  return result
}

function measureScreenshotDifference(nativePng, hostedPng) {
  const firstComparedRow = Math.floor(nativePng.height * STATUS_BAR_MASK_RATIO)
  const rawDifference = measureAlignedDifference(nativePng, hostedPng, firstComparedRow)
  const nativeBlocks = downsampleScreenshot(nativePng, firstComparedRow)
  const hostedBlocks = downsampleScreenshot(hostedPng, firstComparedRow)
  const forwardDifference = measureNeighborhoodDifference(nativeBlocks, hostedBlocks)
  const reverseDifference = measureNeighborhoodDifference(hostedBlocks, nativeBlocks)
  return {
    statusBarMaskRatio: STATUS_BAR_MASK_RATIO,
    pixelChannelDifferenceThreshold: PIXEL_CHANNEL_DIFFERENCE_THRESHOLD,
    comparisonBlockSize: COMPARISON_BLOCK_SIZE,
    neighborhoodRadiusPixels: NEIGHBORHOOD_RADIUS_BLOCKS * COMPARISON_BLOCK_SIZE,
    rawChangedPixelRatio: rawDifference.changedPixelRatio,
    rawMeanChannelDifference: rawDifference.meanChannelDifference,
    changedPixelRatio:
      (forwardDifference.changedPixelRatio + reverseDifference.changedPixelRatio) / 2,
    meanChannelDifference:
      (forwardDifference.meanChannelDifference + reverseDifference.meanChannelDifference) / 2
  }
}

function measureAlignedDifference(nativePng, hostedPng, firstComparedRow) {
  let changedPixels = 0
  let comparedPixels = 0
  let channelDifferenceTotal = 0
  for (let y = firstComparedRow; y < nativePng.height; y++) {
    for (let x = 0; x < nativePng.width; x++) {
      const offset = (y * nativePng.width + x) * 4
      const channelDifference = maxRgbDifference(nativePng.data, hostedPng.data, offset)
      channelDifferenceTotal += channelDifference
      comparedPixels++
      if (channelDifference > PIXEL_CHANNEL_DIFFERENCE_THRESHOLD) {
        changedPixels++
      }
    }
  }
  return {
    changedPixelRatio: changedPixels / comparedPixels,
    meanChannelDifference: channelDifferenceTotal / comparedPixels
  }
}

function downsampleScreenshot(png, firstComparedRow) {
  const width = Math.ceil(png.width / COMPARISON_BLOCK_SIZE)
  const height = Math.ceil((png.height - firstComparedRow) / COMPARISON_BLOCK_SIZE)
  const pixels = new Float32Array(width * height * 3)
  for (let blockY = 0; blockY < height; blockY++) {
    for (let blockX = 0; blockX < width; blockX++) {
      averageBlock(png, pixels, blockX, blockY, firstComparedRow, width)
    }
  }
  return { height, pixels, width }
}

function averageBlock(png, output, blockX, blockY, firstComparedRow, outputWidth) {
  const firstX = blockX * COMPARISON_BLOCK_SIZE
  const firstY = firstComparedRow + blockY * COMPARISON_BLOCK_SIZE
  const lastX = Math.min(firstX + COMPARISON_BLOCK_SIZE, png.width)
  const lastY = Math.min(firstY + COMPARISON_BLOCK_SIZE, png.height)
  const outputOffset = (blockY * outputWidth + blockX) * 3
  let sampleCount = 0
  for (let y = firstY; y < lastY; y++) {
    for (let x = firstX; x < lastX; x++) {
      const inputOffset = (y * png.width + x) * 4
      output[outputOffset] += png.data[inputOffset]
      output[outputOffset + 1] += png.data[inputOffset + 1]
      output[outputOffset + 2] += png.data[inputOffset + 2]
      sampleCount++
    }
  }
  output[outputOffset] /= sampleCount
  output[outputOffset + 1] /= sampleCount
  output[outputOffset + 2] /= sampleCount
}

function measureNeighborhoodDifference(source, target) {
  let changedPixels = 0
  let channelDifferenceTotal = 0
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const channelDifference = nearestBlockDifference(source, target, x, y)
      channelDifferenceTotal += channelDifference
      if (channelDifference > PIXEL_CHANNEL_DIFFERENCE_THRESHOLD) {
        changedPixels++
      }
    }
  }
  const comparedPixels = source.width * source.height
  return {
    changedPixelRatio: changedPixels / comparedPixels,
    meanChannelDifference: channelDifferenceTotal / comparedPixels
  }
}

function nearestBlockDifference(source, target, sourceX, sourceY) {
  const sourceOffset = (sourceY * source.width + sourceX) * 3
  let nearestDifference = 255
  const firstY = Math.max(0, sourceY - NEIGHBORHOOD_RADIUS_BLOCKS)
  const lastY = Math.min(target.height - 1, sourceY + NEIGHBORHOOD_RADIUS_BLOCKS)
  const firstX = Math.max(0, sourceX - NEIGHBORHOOD_RADIUS_BLOCKS)
  const lastX = Math.min(target.width - 1, sourceX + NEIGHBORHOOD_RADIUS_BLOCKS)
  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const targetOffset = (y * target.width + x) * 3
      nearestDifference = Math.min(
        nearestDifference,
        maxRgbDifference(source.pixels, target.pixels, sourceOffset, targetOffset)
      )
    }
  }
  return nearestDifference
}

function maxRgbDifference(nativePixels, hostedPixels, nativeOffset, hostedOffset = nativeOffset) {
  return Math.max(
    Math.abs(nativePixels[nativeOffset] - hostedPixels[hostedOffset]),
    Math.abs(nativePixels[nativeOffset + 1] - hostedPixels[hostedOffset + 1]),
    Math.abs(nativePixels[nativeOffset + 2] - hostedPixels[hostedOffset + 2])
  )
}

async function readScreenshot(screenshotPath) {
  return PNG.sync.read(await readFile(screenshotPath))
}
