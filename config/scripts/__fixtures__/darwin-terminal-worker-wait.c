#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include "darwin-threadpool-wait.h"

static uv_work_t requests[4];
static uv_thread_t workers[4];
static uv_sem_t arrived;
static uv_sem_t release_workers;
static unsigned callbacks;
static int started;
static uv_work_t stress_request;
static uv_loop_t* stress_loop;
static unsigned stress_completed;
static const unsigned stress_target = 30000000;

static void stress_work(uv_work_t* request) {
  (void) request;
}

static void stress_done(uv_work_t* request, int status) {
  if (status != 0)
    abort();
  if (++stress_completed < stress_target &&
      uv_queue_work(stress_loop, request, stress_work, stress_done) != 0)
    abort();
}

static napi_value start_stress(napi_env env, napi_callback_info info) {
  napi_value result;
  (void) info;
  if (stress_loop != NULL ||
      napi_get_uv_event_loop(env, &stress_loop) != napi_ok ||
      uv_queue_work(stress_loop, &stress_request, stress_work, stress_done) != 0)
    abort();
  napi_get_undefined(env, &result);
  return result;
}

static napi_value stress_progress(napi_env env, napi_callback_info info) {
  napi_value result;
  (void) info;
  napi_create_uint32(env, stress_completed, &result);
  return result;
}

static void enroll_worker(uv_work_t* request) {
  workers[request - requests] = uv_thread_self();
  uv_sem_post(&arrived);
  uv_sem_wait(&release_workers);
}

static void complete_work(uv_work_t* request, int status) {
  (void) request;
  if (status != 0)
    abort();
  if (++callbacks == 4) {
    uv_sem_destroy(&arrived);
    uv_sem_destroy(&release_workers);
  }
}

static napi_value enroll(napi_env env, napi_callback_info info) {
  uv_loop_t* loop;
  napi_value result;
  unsigned i;
  (void) info;
  if (started) {
    napi_throw_error(env, NULL, "Workers already enrolled");
    return NULL;
  }
  started = 1;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok ||
      uv_sem_init(&arrived, 0) != 0 ||
      uv_sem_init(&release_workers, 0) != 0)
    abort();
  for (i = 0; i < 4; i++)
    if (uv_queue_work(loop, requests + i, enroll_worker, complete_work) != 0)
      abort();
  for (i = 0; i < 4; i++)
    uv_sem_wait(&arrived);
  for (i = 0; i < 4; i++)
    uv_sem_post(&release_workers);
  napi_get_undefined(env, &result);
  return result;
}

static napi_value snapshot(napi_env env, napi_callback_info info) {
  char output[2048];
  uintptr_t condition;
  uint64_t generation;
  napi_value result;
  unsigned i;
  int at;
  int parked;
  (void) info;
  if (!started) {
    napi_throw_error(env, NULL, "Enroll workers first");
    return NULL;
  }
  at = snprintf(output, sizeof(output),
                "{\"callbacks\":%u,\"waits\":[", callbacks);
  for (i = 0; i < 4; i++) {
    generation = 0;
    parked = read_wait_generation(workers[i], &condition, &generation);
    at += snprintf(output + at, sizeof(output) - at,
                   "%s{\"parked\":%d,\"generation\":\"%llx\"}",
                   i ? "," : "", parked, (unsigned long long) generation);
  }
  snprintf(output + at, sizeof(output) - at, "]}");
  napi_create_string_utf8(env, output, NAPI_AUTO_LENGTH, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "enroll", NAPI_AUTO_LENGTH, enroll, NULL, &function);
  napi_set_named_property(env, exports, "enroll", function);
  napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, NULL, &function);
  napi_set_named_property(env, exports, "snapshot", function);
  napi_create_function(env, "startStress", NAPI_AUTO_LENGTH,
                       start_stress, NULL, &function);
  napi_set_named_property(env, exports, "startStress", function);
  napi_create_function(env, "stressProgress", NAPI_AUTO_LENGTH,
                       stress_progress, NULL, &function);
  napi_set_named_property(env, exports, "stressProgress", function);
  return exports;
}
