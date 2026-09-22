import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyStagingBootstrap } from './classify-relay-staging-bootstrap.mjs'

const state = (c2Kind, c2Admission, c3Kind, c3Admission) => ({
  c2Kind,
  c2Admission,
  c3Kind,
  c3Admission
})

test('classifies the fresh legacy bootstrap', () => {
  assert.equal(
    classifyStagingBootstrap(state('legacy', 'general', 'legacy', 'general')),
    'normalize-and-roll-both'
  )
})

test('retries normalization after a failed C3 restart', () => {
  assert.equal(
    classifyStagingBootstrap(state('legacy', 'general', 'legacy', 'migration-only')),
    'normalize-and-roll-both'
  )
})

test('resumes after C2 isolation', () => {
  assert.equal(
    classifyStagingBootstrap(state('legacy', 'migration-only', 'legacy', 'general')),
    'resume-c2-then-c3'
  )
})

test('resumes after C2 apply or a partial C3 transition', () => {
  for (const c2Admission of ['general', 'migration-only']) {
    for (const c3Admission of ['general', 'migration-only']) {
      assert.equal(
        classifyStagingBootstrap(state('modern', c2Admission, 'legacy', c3Admission)),
        'roll-c3'
      )
    }
  }
})

test('repairs an unexpected modern C3 before rolling legacy C2', () => {
  assert.equal(
    classifyStagingBootstrap(state('legacy', 'migration-only', 'modern', 'general')),
    'roll-c2'
  )
})

test('accepts already complete modern cells and rejects no-fallback legacy state', () => {
  assert.equal(
    classifyStagingBootstrap(state('modern', 'migration-only', 'modern', 'general')),
    'complete'
  )
  assert.throws(
    () => classifyStagingBootstrap(state('legacy', 'migration-only', 'legacy', 'migration-only')),
    /no general fallback/
  )
})
