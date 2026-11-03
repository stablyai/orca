import { Worker } from 'node:worker_threads'
import { vi } from 'vitest'
import { journalDatabasePath } from './journal-host-database'
import type { JournalHostDatabase } from './journal-host-database'

/** Test bundles instrument the actual worker connection, never a second fixture connection. */
export const journalNativeTestInstrumentation = `
const testSqlite = require('node:sqlite');
const testPort = require('node:worker_threads').parentPort;
const testPrepare = testSqlite.DatabaseSync.prototype.prepare;
const testExec = testSqlite.DatabaseSync.prototype.exec;
const testClose = testSqlite.DatabaseSync.prototype.close;
const testOn = testPort.on.bind(testPort);
const testPost = testPort.postMessage.bind(testPort);
let testFailure;
let testTransactions = [];
let testRowInserts = 0;
let testSql = [];
testSqlite.DatabaseSync.prototype.prepare = function(sql) {
  const statement = testPrepare.call(this, sql);
  testSql.push({ sql, method: 'prepare', rows: 0, changes: 0 });
  for (const method of ['all', 'get', 'run']) {
    const original = statement[method];
    statement[method] = function(...args) {
      const result = original.apply(this, args);
      if (method === 'run' && /^INSERT INTO journal_rows\\b/.test(sql)) testRowInserts += Number(result.changes);
      testSql.push({ sql, method, rows: method === 'all' ? result.length : method === 'get' ? Number(!!result) : 0, changes: method === 'run' ? Number(result.changes) : 0, position: typeof args[0] === 'number' ? args[0] : undefined });
      return result;
    };
  }
  const iterate = statement.iterate;
  statement.iterate = function*(...args) {
    const entry = { sql, method: 'iterate', rows: 0, changes: 0, position: typeof args[0] === 'number' ? args[0] : undefined };
    testSql.push(entry);
    for (const row of iterate.apply(this, args)) {
      testSql.push({ sql, method: 'row', rows: 1, changes: 0 });
      yield row;
    }
  };
  return statement;
};
testSqlite.DatabaseSync.prototype.exec = function(sql) {
  testSql.push({ sql, method: 'exec', rows: 0, changes: 0 });
  if (sql === 'BEGIN IMMEDIATE') testRowInserts = 0;
  if (sql === 'COMMIT' || sql === 'ROLLBACK') {
    testTransactions.push({ sql, rowInserts: testRowInserts, synchronous: Object.values(testPrepare.call(this, 'PRAGMA synchronous').get())[0] });
  }
  if (testFailure && sql === testFailure.sql) {
    const failure = testFailure;
    testFailure = undefined;
    throw new Error(failure.message);
  }
  return testExec.call(this, sql);
};
testSqlite.DatabaseSync.prototype.close = function() {
  if (testFailure?.sql === 'CLOSE') {
    const failure = testFailure;
    testFailure = undefined;
    throw new Error(failure.message);
  }
  return testClose.call(this);
};
testPort.on = function(event, listener) {
  return testOn(event, event === 'message' ? (message) => {
    if (message?.type === 'journal-test-control') {
      testFailure = message.failure;
      testPost({ type: 'journal-test-controlled', id: message.id });
      return;
    }
    listener(message);
  } : listener);
};
testPort.postMessage = (message) => {
  const nativeTransactions = testTransactions;
  testTransactions = [];
  const nativeSql = testSql.map((entry) => ({ ...entry }));
  testSql = [];
  testPost({ ...message, nativeTransactions, nativeSql, testFilename: require('node:worker_threads').workerData.filename });
};
`

type Transaction = { sql: string; synchronous: number; rowInserts: number }
export function observeNativeJournalTransactions(
  database: JournalHostDatabase,
  visit: (transaction: Transaction) => void
): () => void {
  const worker = database['owner']['worker']
  const listener = (message: { nativeTransactions?: Transaction[] }): void => {
    for (const transaction of message.nativeTransactions ?? []) {
      visit(transaction)
    }
  }
  worker.on('message', listener)
  return () => worker.off('message', listener)
}

let nextControl = 0
export function failNextNativeJournalStatement(
  database: JournalHostDatabase,
  sql: string,
  message: string
): Promise<void> {
  const worker = database['owner']['worker']
  const id = --nextControl
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      worker.off('message', received)
      worker.off('exit', exited)
    }
    const received = (reply: { type?: string; id?: number }): void => {
      if (reply.type !== 'journal-test-controlled' || reply.id !== id) {
        return
      }
      cleanup()
      resolve()
    }
    const exited = (): void => {
      cleanup()
      reject(new Error('journal test worker exited before control acknowledgement'))
    }
    worker.on('message', received)
    worker.on('exit', exited)
    try {
      worker.postMessage({ type: 'journal-test-control', id, failure: { sql, message } })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

export type NativeJournalSqlObservation = {
  sql: string
  method: 'all' | 'get' | 'run' | 'iterate' | 'exec' | 'row' | 'prepare'
  rows: number
  changes: number
  position?: number
}

/** Observe all actual native owners for one profile, including readers created after registration. */
export function observeNativeJournalSql(
  database: JournalHostDatabase,
  visit: (entry: NativeJournalSqlObservation) => void
): () => void {
  const emit = Worker.prototype.emit
  const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const message: unknown = args[0]
    if (
      event === 'message' &&
      typeof message === 'object' &&
      message !== null &&
      'testFilename' in message &&
      message.testFilename === journalDatabasePath(database.stateDirectory) &&
      'nativeSql' in message &&
      Array.isArray(message.nativeSql)
    ) {
      for (const entry of message.nativeSql) {
        if (isNativeSqlObservation(entry)) {
          visit(entry)
        }
      }
    }
    return emit.call(this, event, ...args)
  })
  return () => spy.mockRestore()
}

function isNativeSqlObservation(entry: unknown): entry is NativeJournalSqlObservation {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'sql' in entry &&
    typeof entry.sql === 'string' &&
    'method' in entry &&
    typeof entry.method === 'string' &&
    ['all', 'get', 'run', 'iterate', 'exec', 'row', 'prepare'].includes(entry.method) &&
    'rows' in entry &&
    typeof entry.rows === 'number' &&
    'changes' in entry &&
    typeof entry.changes === 'number'
  )
}
