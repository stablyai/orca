#ifndef ORCA_PROC_API_ARGUMENTS_H
#define ORCA_PROC_API_ARGUMENTS_H

#include <node_api.h>
#include <stddef.h>
#include <stdint.h>

int read_process_pid_argument(napi_env env, napi_callback_info info, int32_t *pid);
int read_process_tty_argument(napi_env env, napi_callback_info info, char *out, size_t size);

#endif
